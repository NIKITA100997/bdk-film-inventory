from collections import defaultdict
from difflib import SequenceMatcher

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.core.security import require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import Color, Material, MaterialSku, Part
from app.models.items import Item, ItemComponent, ItemGroup, ItemKind, ItemType, fmt_num as _fmt, normalize_name, size_part_name, sku_item_name
from app.models.production import ProductionTask, ProductionTaskLine, ProductModel, ProductModelPart
from app.services import item_attrs
from app.services.laminated import can_laminate, laminated_part
from app.services.components import live_item_names, sync_bom_components
from app.services.routes import RouteInUseError, RouteStep, apply_route

router = APIRouter(tags=["items"])

# Просмотр номенклатуры и карточки позиции — и кладовщикам плёнки (приёмка,
# выдача, возврат): карточка позиции заменила карточку материала. Только
# просмотр — правка по своим правам.
view_items = require_permission(
    "materials.manage", "production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view",
    "units.receive", "units.issue", "units.return",
)
link_lines = require_permission("production_tasks.manage")
manage_groups = require_permission("production_tasks.manage", "materials.manage")


class ItemKindOut(BaseModel):
    id: int
    code: str
    name: str
    unit: str
    lot_tracking: bool


class ItemOut(BaseModel):
    id: int
    kind_code: str
    kind_name: str
    unit: str
    name: str
    code_1c: str | None
    is_active: bool
    # Откуда позиция на переходном этапе и как открыть её привычную карточку.
    source_type: str | None  # "sku" | "part" | "model"
    source_id: int | None
    group_id: int | None = None
    is_model: bool = False
    model_id: int | None = None
    type_id: int | None = None
    material: str | None = None
    color: str | None = None
    thickness: float | None = None
    pet_type: str | None = None  # "3d"; пусто — ПЭТ 2Д
    # Признаки (services/item_attrs.py) — действующие: своё или как у типа.
    direction: str | None = None
    stage: str | None = None
    make_mode: str | None = None
    # Задано у самой позиции (а не взято у типа / по правилу).
    own_attrs: list[str] = []


class PartSuggestion(BaseModel):
    part_id: int
    part_name: str
    score: float


class UnlinkedLineGroup(BaseModel):
    part_name: str
    bom_lines: int
    task_lines: int
    active_task_lines: int
    suggestions: list[PartSuggestion]


class LinkLinesIn(BaseModel):
    part_name: str
    part_id: int


class LinkLinesOut(BaseModel):
    bom_lines: int
    task_lines: int


@router.get("/item-kinds", response_model=list[ItemKindOut])
def list_item_kinds(db: Session = Depends(get_db), user=Depends(view_items)) -> list[ItemKind]:
    return db.query(ItemKind).filter(ItemKind.is_active.is_(True)).order_by(ItemKind.sort_order).all()


@router.get("/items", response_model=list[ItemOut])
def list_items(
    kind: str | None = Query(default=None),
    q: str | None = Query(default=None),
    include_inactive: bool = Query(default=False),
    db: Session = Depends(get_db),
    user=Depends(view_items),
) -> list[ItemOut]:
    """Вся номенклатура одним списком. Название — живое, из исходной таблицы
    (там оно правится), а не снимок в items.name."""
    kinds = {k.id: k for k in db.query(ItemKind)}
    items = {i.id: i for i in db.query(Item)}
    types = {t.id: t for t in db.query(ItemType)}
    out: list[ItemOut] = []
    seen: set[int] = set()

    def add(item_id: int | None, name: str, active: bool, source_type: str, source_id: int, **extra) -> None:
        item = items.get(item_id) if item_id else None
        if item is None:
            return
        kind = kinds[item.kind_id]
        seen.add(item.id)
        out.append(
            ItemOut(
                id=item.id, kind_code=kind.code, kind_name=kind.name, unit=item.unit or kind.unit, name=name,
                code_1c=item.code_1c, is_active=active, source_type=source_type, source_id=source_id,
                group_id=item.group_id, is_model=item.is_model, model_id=item.model_id, type_id=item.type_id, pet_type=item.pet_type, **_attrs(item, kind.code, types), **extra,
            )
        )

    skus = (
        db.query(MaterialSku)
        .options(
            joinedload(MaterialSku.material), joinedload(MaterialSku.color),
            joinedload(MaterialSku.thickness), joinedload(MaterialSku.manufacturer),
        )
        .all()
    )
    for s in skus:
        add(
            s.item_id, sku_item_name(s.material.name, s.color.name, s.thickness.value_mm, s.manufacturer.name),
            s.is_active, "sku", s.id, material=s.material.name, color=s.color.name, thickness=float(s.thickness.value_mm),
        )
    for p in db.query(Part):
        add(p.item_id, p.name, p.is_active, "part", p.id)
    for m in db.query(ProductModel):
        add(m.item_id, m.name, m.is_active, "model", m.id)
    for item in items.values():
        if item.id not in seen:
            # Позиция без своей таблицы (ГП по типу и т.п.). Не называть
            # переменную kind — это параметр фильтра выше по функции.
            item_kind = kinds[item.kind_id]
            out.append(
                ItemOut(
                    id=item.id, kind_code=item_kind.code, kind_name=item_kind.name, unit=item.unit or item_kind.unit, name=item.name,
                    code_1c=item.code_1c, is_active=item.is_active, source_type=None, source_id=None,
                    group_id=item.group_id, is_model=item.is_model, model_id=item.model_id, type_id=item.type_id,
                    pet_type=item.pet_type, **_attrs(item, item_kind.code, types),
                )
            )

    if kind:
        out = [i for i in out if i.kind_code == kind]
    if not include_inactive:
        out = [i for i in out if i.is_active]
    if q and q.strip():
        needle = normalize_name(q)
        out = [i for i in out if needle in normalize_name(i.name) or (i.code_1c and needle in i.code_1c.lower())]
    order = {k.code: k.sort_order for k in kinds.values()}
    return sorted(out, key=lambda i: (order.get(i.kind_code, 99), i.name.lower()))


class GroupOut(BaseModel):
    id: int
    kind_code: str
    parent_id: int | None
    name: str
    sort_order: int
    items: int  # позиций прямо в группе (без подгрупп)


class GroupIn(BaseModel):
    kind_code: str
    parent_id: int | None = None
    name: str = Field(min_length=1, max_length=128)
    sort_order: int = 0


class GroupUpdate(BaseModel):
    parent_id: int | None = None
    name: str = Field(min_length=1, max_length=128)
    sort_order: int = 0


class SetGroupIn(BaseModel):
    item_ids: list[int]
    group_id: int | None = None


def _group_out(db: Session, g: ItemGroup, kinds: dict[int, ItemKind]) -> GroupOut:
    n = db.query(func.count(Item.id)).filter(Item.group_id == g.id).scalar() or 0
    return GroupOut(id=g.id, kind_code=kinds[g.kind_id].code, parent_id=g.parent_id, name=g.name, sort_order=g.sort_order, items=n)


def _check_parent(db: Session, kind_id: int, parent_id: int | None, self_id: int | None = None) -> None:
    """Родитель — того же вида и не сама группа и не её потомок (без циклов)."""
    seen: set[int] = set()
    pid = parent_id
    while pid is not None:
        if pid == self_id or pid in seen:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Группу нельзя вложить саму в себя")
        seen.add(pid)
        parent = db.get(ItemGroup, pid)
        if parent is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Родительская группа не найдена")
        if parent.kind_id != kind_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Родительская группа — другого вида номенклатуры")
        pid = parent.parent_id


def _check_name(db: Session, kind_id: int, parent_id: int | None, name: str, self_id: int | None = None) -> None:
    q = db.query(ItemGroup.id).filter(
        ItemGroup.kind_id == kind_id, ItemGroup.parent_id.is_(None) if parent_id is None else ItemGroup.parent_id == parent_id,
        func.lower(ItemGroup.name) == name.strip().lower(),
    )
    if self_id is not None:
        q = q.filter(ItemGroup.id != self_id)
    if q.first():
        raise HTTPException(status.HTTP_409_CONFLICT, f"Группа «{name.strip()}» здесь уже есть")


@router.get("/item-groups", response_model=list[GroupOut])
def list_groups(db: Session = Depends(get_db), user=Depends(view_items)) -> list[GroupOut]:
    kinds = {k.id: k for k in db.query(ItemKind)}
    return [_group_out(db, g, kinds) for g in db.query(ItemGroup).order_by(ItemGroup.sort_order, ItemGroup.name)]


@router.post("/item-groups", response_model=GroupOut, status_code=status.HTTP_201_CREATED)
def create_group(payload: GroupIn, db: Session = Depends(get_db), user=Depends(manage_groups)) -> GroupOut:
    kind = db.query(ItemKind).filter(ItemKind.code == payload.kind_code).first()
    if kind is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Вид номенклатуры не найден")
    _check_parent(db, kind.id, payload.parent_id)
    _check_name(db, kind.id, payload.parent_id, payload.name)
    g = ItemGroup(kind_id=kind.id, parent_id=payload.parent_id, name=payload.name.strip(), sort_order=payload.sort_order)
    db.add(g)
    db.commit()
    return _group_out(db, g, {k.id: k for k in db.query(ItemKind)})


@router.put("/item-groups/{group_id}", response_model=GroupOut)
def update_group(group_id: int, payload: GroupUpdate, db: Session = Depends(get_db), user=Depends(manage_groups)) -> GroupOut:
    g = db.get(ItemGroup, group_id)
    if g is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Группа не найдена")
    _check_parent(db, g.kind_id, payload.parent_id, self_id=g.id)
    _check_name(db, g.kind_id, payload.parent_id, payload.name, self_id=g.id)
    g.parent_id, g.name, g.sort_order = payload.parent_id, payload.name.strip(), payload.sort_order
    db.commit()
    return _group_out(db, g, {k.id: k for k in db.query(ItemKind)})


@router.delete("/item-groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_group(group_id: int, db: Session = Depends(get_db), user=Depends(manage_groups)) -> None:
    """Удалить можно только пустую группу — без позиций и подгрупп."""
    g = db.get(ItemGroup, group_id)
    if g is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Группа не найдена")
    if db.query(ItemGroup.id).filter(ItemGroup.parent_id == g.id).first():
        raise HTTPException(status.HTTP_409_CONFLICT, f"В группе «{g.name}» есть подгруппы — сначала удалите или перенесите их")
    n = db.query(func.count(Item.id)).filter(Item.group_id == g.id).scalar() or 0
    if n:
        raise HTTPException(status.HTTP_409_CONFLICT, f"В группе «{g.name}» позиций: {n} — сначала перенесите их")
    db.delete(g)
    db.commit()


@router.post("/items/set-group")
def set_items_group(payload: SetGroupIn, db: Session = Depends(get_db), user=Depends(manage_groups)) -> dict:
    """Перенести позиции в группу (group_id = null — убрать из групп). Все
    позиции должны быть того же вида, что и группа."""
    group = db.get(ItemGroup, payload.group_id) if payload.group_id is not None else None
    if payload.group_id is not None and group is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Группа не найдена")
    items = db.query(Item).filter(Item.id.in_(payload.item_ids)).all() if payload.item_ids else []
    if group is not None:
        alien = [i for i in items if i.kind_id != group.kind_id]
        if alien:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, f"Позиции другого вида в эту группу не переносятся (например, «{alien[0].name}»)"
            )
    for i in items:
        i.group_id = group.id if group else None
    db.commit()
    return {"moved": len(items)}


def _attrs(item: Item, kind_code: str, types: dict[int, ItemType]) -> dict:
    t = types.get(item.type_id) if item.type_id else None
    return {
        "direction": item_attrs.effective_direction(item, t),
        "stage": item_attrs.effective_stage(item, t),
        "make_mode": item_attrs.effective_mode(item, kind_code, t),
        "own_attrs": [f for f in ("direction", "stage", "make_mode") if getattr(item, f)],
    }


AUTO = "auto"  # в массовом изменении: убрать своё значение, брать у типа / по правилу


class SetAttrsIn(BaseModel):
    item_ids: list[int]
    # None — не менять; "auto" — как у типа / по правилу; иначе код.
    direction: str | None = None
    stage: str | None = None
    make_mode: str | None = None


@router.post("/items/set-attrs")
def set_items_attrs(payload: SetAttrsIn, db: Session = Depends(get_db), user=Depends(manage_groups)) -> dict:
    """Массово: направление, стадия, режим. Стадия и режим — только у п/ф."""
    allowed = {"direction": item_attrs.DIRECTIONS, "stage": item_attrs.STAGES, "make_mode": item_attrs.MODES}
    changes = {f: getattr(payload, f) for f in allowed if getattr(payload, f) is not None}
    for f, v in changes.items():
        if v != AUTO and v not in allowed[f]:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Неизвестное значение: {v}")
    items = db.query(Item).filter(Item.id.in_(payload.item_ids)).all() if payload.item_ids else []
    kinds = {k.id: k.code for k in db.query(ItemKind)}
    if "stage" in changes or "make_mode" in changes:
        alien = [i for i in items if kinds.get(i.kind_id) != "pf"]
        if alien:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, f"Стадия и режим — только у п/ф (например, не у «{alien[0].name}»)"
            )
    for i in items:
        for f, v in changes.items():
            setattr(i, f, None if v == AUTO else v)
    db.commit()
    return {"updated": len(items)}


class LaminatedRef(BaseModel):
    item_id: int
    name: str
    stock: float = 0  # на хранении и на участках, шт


class LaminatedOut(BaseModel):
    base: LaminatedRef | None  # у позиции в плёнке — деталь без плёнки
    variants: list[LaminatedRef]  # у детали без плёнки — её позиции в плёнке
    can_laminate: bool


class LaminatedIn(BaseModel):
    material_id: int | None = None
    color_id: int


def _stock_of_item(db: Session, item_id: int) -> float:
    from app.models.part_units import PartUnit, PartUnitStatus

    part = db.query(Part).filter(Part.item_id == item_id).first()
    if part is None:
        return 0.0
    return float(
        db.query(func.coalesce(func.sum(PartUnit.quantity_pieces), 0))
        .filter(PartUnit.part_id == part.id, PartUnit.status.in_([PartUnitStatus.NA_KHRANENII, PartUnitStatus.VYDAN_UCHASTKU]))
        .scalar()
    )


@router.get("/items/{item_id}/laminated", response_model=LaminatedOut)
def item_laminated(item_id: int, db: Session = Depends(get_db), user=Depends(view_items)) -> LaminatedOut:
    """Деталь в плёнке: у детали — её позиции «деталь · декор», у позиции в
    плёнке — деталь без плёнки."""
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    base = db.get(Item, item.base_item_id) if item.base_item_id else None
    part = db.query(Part).filter(Part.item_id == item.id).first()
    variants = db.query(Item).filter(Item.base_item_id == item.id).order_by(Item.name).all()
    return LaminatedOut(
        base=LaminatedRef(item_id=base.id, name=base.name, stock=_stock_of_item(db, base.id)) if base else None,
        variants=[LaminatedRef(item_id=v.id, name=v.name, stock=_stock_of_item(db, v.id)) for v in variants],
        can_laminate=can_laminate(db, part),
    )


@router.post("/items/{item_id}/laminated", response_model=LaminatedRef)
def create_item_laminated(
    item_id: int, payload: LaminatedIn, db: Session = Depends(get_db), user=Depends(manage_groups)
) -> LaminatedRef:
    """Завести позицию «деталь · декор» вручную (например, чтобы внести
    остаток склада ламинированных). Есть такая — вернёт её."""
    part = db.query(Part).filter(Part.item_id == item_id).first()
    if not can_laminate(db, part):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Позицию в плёнке можно завести только от детали п/ф без плёнки")
    if db.get(Color, payload.color_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Цвет не найден")
    lam = laminated_part(db, part, payload.material_id, payload.color_id)
    db.commit()
    return LaminatedRef(item_id=lam.item_id, name=lam.name, stock=_stock_of_item(db, lam.item_id))


PET_TYPES = ("2d", "3d")


class SetPetIn(BaseModel):
    item_ids: list[int]
    pet_type: str  # "2d" | "3d"


@router.post("/items/set-pet")
def set_items_pet(payload: SetPetIn, db: Session = Depends(get_db), user=Depends(manage_groups)) -> dict:
    """Массово: какой ПЭТ идёт на детали, если декор ПЭТ. 2Д — основа
    (хранится пусто), 3Д — отмечается. Только п/ф."""
    if payload.pet_type not in PET_TYPES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "ПЭТ — 2Д или 3Д")
    items = db.query(Item).filter(Item.id.in_(payload.item_ids)).all() if payload.item_ids else []
    pf = db.query(ItemKind).filter(ItemKind.code == "pf").first()
    alien = [i for i in items if pf is None or i.kind_id != pf.id]
    if alien:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"ПЭТ задаётся только у п/ф (например, не у «{alien[0].name}»)")
    for i in items:
        i.pet_type = "3d" if payload.pet_type == "3d" else None
    db.commit()
    return {"updated": len(items)}


def _suggest(name: str, parts: list[Part]) -> list[PartSuggestion]:
    key = normalize_name(name)
    scored = sorted(
        ((SequenceMatcher(None, key, normalize_name(p.name)).ratio(), p) for p in parts),
        key=lambda x: x[0],
        reverse=True,
    )
    return [PartSuggestion(part_id=p.id, part_name=p.name, score=round(r, 2)) for r, p in scored[:3] if r >= 0.5]


def strip_decor(name: str) -> str:
    """«Добор телескоп 10х100х2070 (ПЭТ Бежевый (cream silk))» → «Добор
    телескоп 10х100х2070»: у строки задания с плёнкой последняя скобка —
    декор (он и так есть в плёнке строки), деталь — без неё."""
    name = name.rstrip()
    if not name.endswith(")"):
        return name
    depth = 0
    for i in range(len(name) - 1, -1, -1):
        if name[i] == ")":
            depth += 1
        elif name[i] == "(":
            depth -= 1
            if depth == 0:
                base = name[:i].rstrip()
                return base or name
    return name


def _task_line_key(name: str, has_film: bool) -> str:
    return normalize_name(strip_decor(name) if has_film else name)


@router.get("/items/unlinked-lines", response_model=list[UnlinkedLineGroup])
def list_unlinked_lines(db: Session = Depends(get_db), user=Depends(view_items)) -> list[UnlinkedLineGroup]:
    """Строки BOM моделей и заданий цеха с названием детали, которой нет в
    справочнике: такие строки не списывают п/ф и не попадают в потребность.
    Группировка по названию — одна кнопка «связать» на все его строки."""
    groups: dict[str, dict[str, int | str]] = defaultdict(lambda: {"bom": 0, "task": 0, "active": 0, "name": ""})
    for (name,) in db.query(ProductModelPart.part_name).filter(
        ProductModelPart.part_name.isnot(None), ProductModelPart.part_id.is_(None)
    ):
        g = groups[normalize_name(name)]
        g["bom"] += 1
        g["name"] = g["name"] or name
    rows = (
        db.query(ProductionTaskLine.part_name, ProductionTaskLine.color_id, ProductionTask.is_active)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTaskLine.part_name.isnot(None), ProductionTaskLine.part_id.is_(None))
    )
    # Строки с плёнкой — без декора в конце названия: все декоры одной
    # детали (погонаж «… (Бьянко)», «… (Аляска)») — одна группа.
    for name, color_id, active in rows:
        g = groups[_task_line_key(name, color_id is not None)]
        g["task"] += 1
        g["active"] += 1 if active else 0
        g["name"] = g["name"] or (strip_decor(name) if color_id is not None else name)
    parts = db.query(Part).filter(Part.is_active.is_(True)).all()
    out = [
        UnlinkedLineGroup(
            part_name=str(g["name"]), bom_lines=int(g["bom"]), task_lines=int(g["task"]),
            active_task_lines=int(g["active"]), suggestions=_suggest(str(g["name"]), parts),
        )
        for g in groups.values()
    ]
    return sorted(out, key=lambda g: (-g.active_task_lines, -g.bom_lines, g.part_name.lower()))


@router.post("/items/link-lines", response_model=LinkLinesOut)
def link_unlinked_lines(payload: LinkLinesIn, db: Session = Depends(get_db), user=Depends(link_lines)) -> LinkLinesOut:
    """Связать все строки BOM и заданий с этим названием (без ссылки) с
    выбранной деталью. Название в строках не меняется — только ссылка."""
    part = db.get(Part, payload.part_id)
    if part is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Деталь не найдена")
    key = normalize_name(payload.part_name)
    counts = {"bom": 0, "task": 0}
    touched_models: set[int] = set()
    for model, label in ((ProductModelPart, "bom"), (ProductionTaskLine, "task")):
        for line in db.query(model).filter(model.part_name.isnot(None), model.part_id.is_(None)):
            has_film = label == "task" and line.color_id is not None
            if normalize_name(line.part_name) == key or (has_film and _task_line_key(line.part_name, True) == key):
                line.part_id = part.id
                counts[label] += 1
                if label == "bom":
                    touched_models.add(line.product_model_id)
    db.flush()
    sync_bom_components(db, touched_models)
    db.commit()
    return LinkLinesOut(bom_lines=counts["bom"], task_lines=counts["task"])


class ManualLinkGroup(BaseModel):
    part_name: str
    part_id: int
    linked_part_name: str
    bom_lines: int
    task_lines: int


@router.get("/items/manual-links", response_model=list[ManualLinkGroup])
def list_manual_links(db: Session = Depends(get_db), user=Depends(view_items)) -> list[ManualLinkGroup]:
    """Связи, сделанные вручную кнопкой «Связать»: название в строке не
    совпадает с названием детали. Связи по совпадающему названию система
    ставит сама — их здесь нет, снимать их незачем."""
    parts = {p.id: p for p in db.query(Part)}
    groups: dict[tuple[str, int], dict] = {}
    for model, label in ((ProductModelPart, "bom"), (ProductionTaskLine, "task")):
        for name, part_id in db.query(model.part_name, model.part_id).filter(
            model.part_name.isnot(None), model.part_id.isnot(None)
        ):
            part = parts.get(part_id)
            if part is None or normalize_name(part.name) == normalize_name(name):
                continue
            g = groups.setdefault(
                (normalize_name(name), part_id),
                {"part_name": name, "part_id": part_id, "linked_part_name": part.name, "bom": 0, "task": 0},
            )
            g[label] += 1
    return sorted(
        (
            ManualLinkGroup(
                part_name=g["part_name"], part_id=g["part_id"], linked_part_name=g["linked_part_name"],
                bom_lines=g["bom"], task_lines=g["task"],
            )
            for g in groups.values()
        ),
        key=lambda g: g.part_name.lower(),
    )


@router.post("/items/unlink-lines", response_model=LinkLinesOut)
def unlink_lines(payload: LinkLinesIn, db: Session = Depends(get_db), user=Depends(link_lines)) -> LinkLinesOut:
    """Снять ручную связь: строки с этим названием, привязанные к этой детали,
    снова без детали (отчёты по ним перестанут двигать её партии)."""
    key = normalize_name(payload.part_name)
    counts = {"bom": 0, "task": 0}
    touched_models: set[int] = set()
    for model, label in ((ProductModelPart, "bom"), (ProductionTaskLine, "task")):
        for line in db.query(model).filter(model.part_id == payload.part_id, model.part_name.isnot(None)):
            if normalize_name(line.part_name) == key:
                line.part_id = None
                counts[label] += 1
                if label == "bom":
                    touched_models.add(line.product_model_id)
    db.flush()
    sync_bom_components(db, touched_models)
    db.commit()
    return LinkLinesOut(bom_lines=counts["bom"], task_lines=counts["task"])


class SizeCandidate(BaseModel):
    part_name: str
    width_mm: float
    length_m: float
    strip_width_mm: float | None
    area: str | None
    proposed_name: str
    existing_part_id: int | None  # позиция с таким названием уже есть — только связать
    bom_lines: int
    task_lines: int
    active_task_lines: int


def _size_key(name: str, width: float, length: float) -> tuple[str, float, float]:
    return (normalize_name(name), round(float(width), 2), round(float(length), 3))


def _unlinked_size_groups(db: Session) -> dict[tuple[str, float, float], dict]:
    groups: dict[tuple[str, float, float], dict] = {}

    def add(line, kind: str, area: str | None, active: bool) -> None:
        g = groups.setdefault(
            _size_key(line.part_name, line.width_mm, line.length_m),
            {"name": line.part_name, "width": float(line.width_mm), "length": float(line.length_m),
             "strips": defaultdict(int), "areas": set(), "bom": [], "task": [], "active": 0},
        )
        g[kind].append(line)
        g["active"] += 1 if active else 0
        if line.strip_width_mm is not None:
            g["strips"][float(line.strip_width_mm)] += 1
        if area:
            g["areas"].add(area)

    for line in db.query(ProductModelPart).filter(ProductModelPart.part_name.isnot(None), ProductModelPart.part_id.is_(None)):
        add(line, "bom", line.area, False)
    rows = (
        db.query(ProductionTaskLine, ProductionTask.area, ProductionTask.is_active)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTaskLine.part_name.isnot(None), ProductionTaskLine.part_id.is_(None))
    )
    for line, area, active in rows:
        add(line, "task", area, bool(active))
    return groups


def _proposed_names(groups: dict) -> dict[tuple, str]:
    """Размер в названии, но под этим названием несколько размеров — всё
    равно дописываем размер, иначе позиции совпадут по названию."""
    names = {k: size_part_name(g["name"], g["width"], g["length"]) for k, g in groups.items()}
    counts: dict[str, int] = defaultdict(int)
    for n in names.values():
        counts[normalize_name(n)] += 1
    for k, n in names.items():
        if counts[normalize_name(n)] > 1:
            g = groups[k]
            names[k] = f"{' '.join(g['name'].split())} {_fmt(g['width'])}х{_fmt(round(g['length'] * 1000, 1))}"
    return names


@router.get("/items/size-candidates", response_model=list[SizeCandidate])
def list_size_candidates(db: Session = Depends(get_db), user=Depends(view_items)) -> list[SizeCandidate]:
    """Строки без детали, сгруппированные по названию И размеру — каждая
    группа станет своей позицией номенклатуры (решение 24.09: отдельная
    позиция на размер)."""
    groups = _unlinked_size_groups(db)
    names = _proposed_names(groups)
    existing = {normalize_name(p.name): p.id for p in db.query(Part)}
    out = []
    for k, g in groups.items():
        strip = max(g["strips"].items(), key=lambda x: x[1])[0] if g["strips"] else None
        out.append(
            SizeCandidate(
                part_name=g["name"], width_mm=g["width"], length_m=g["length"], strip_width_mm=strip,
                area=next(iter(g["areas"])) if len(g["areas"]) == 1 else None,
                proposed_name=names[k], existing_part_id=existing.get(normalize_name(names[k])),
                bom_lines=len(g["bom"]), task_lines=len(g["task"]), active_task_lines=g["active"],
            )
        )
    return sorted(out, key=lambda c: (-c.active_task_lines, c.proposed_name.lower()))


class SizeCreateIn(BaseModel):
    keys: list[tuple[str, float, float]]  # (part_name, width_mm, length_m) из списка кандидатов
    route_part_id: int | None = None  # маршрут — как у этой детали


class SizeCreateOut(BaseModel):
    created: int
    linked_existing: int
    bom_lines: int
    task_lines: int


@router.post("/items/size-parts", response_model=SizeCreateOut)
def create_size_parts(payload: SizeCreateIn, db: Session = Depends(get_db), user=Depends(link_lines)) -> SizeCreateOut:
    """Завести позиции п/ф по выбранным группам и связать с ними их строки.
    Если позиция с таким названием уже есть — только связать."""
    route: list[RouteStep] = []
    if payload.route_part_id is not None:
        template = db.get(Part, payload.route_part_id)
        if template is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Деталь-образец маршрута не найдена")
        route = [RouteStep(code=s.code, name=s.name, area=s.area, role=s.role) for s in template.stages]
    groups = _unlinked_size_groups(db)
    names = _proposed_names(groups)
    existing = {normalize_name(p.name): p for p in db.query(Part)}
    created = linked_existing = bom = task = 0
    for name, width, length in payload.keys:
        k = _size_key(name, width, length)
        g = groups.get(k)
        if g is None:
            continue  # уже связали (повторное нажатие) — не ошибка
        part = existing.get(normalize_name(names[k]))
        if part is None:
            strip = max(g["strips"].items(), key=lambda x: x[1])[0] if g["strips"] else None
            part = Part(
                name=names[k], width_mm=g["width"], length_m=g["length"], strip_width_mm=strip,
                area=next(iter(g["areas"])) if len(g["areas"]) == 1 else None, is_active=True,
            )
            db.add(part)
            db.flush()
            if route:
                apply_route(db, part, route)
            existing[normalize_name(part.name)] = part
            created += 1
        else:
            linked_existing += 1
        for line in g["bom"]:
            line.part_id = part.id
        for line in g["task"]:
            line.part_id = part.id
        bom += len(g["bom"])
        task += len(g["task"])
    db.flush()
    sync_bom_components(db, {line.product_model_id for g in groups.values() for line in g["bom"] if line.part_id})
    db.commit()
    return SizeCreateOut(created=created, linked_existing=linked_existing, bom_lines=bom, task_lines=task)


class TechOperation(BaseModel):
    id: int | None = None
    sequence_order: int
    code: str | None = None
    name: str
    area: str | None
    area_name: str | None
    role: str | None = None


class TechInput(BaseModel):
    name: str
    part_id: int | None  # вход — позиция п/ф (None — строка ещё не связана)
    qty_per_unit: float | None
    unit: str
    note: str | None = None
    # Строка общего состава (пункт 3): позиция-компонент, откуда строка
    # ("bom" — из BOM модели, "manual", "rule"; None — плёнка детали или
    # несвязанная строка BOM) и операция, на которой расходуется.
    component_item_id: int | None = None
    source: str | None = None
    stage_id: int | None = None
    operation_name: str | None = None
    # «Или»: строки с одним номером — варианты друг друга; только из брака.
    alt_group: int | None = None
    from_defect: bool = False


class TechUsage(BaseModel):
    name: str
    source_type: str  # "model" | "part" | "item"
    source_id: int
    qty_per_unit: float | None
    item_id: int | None = None


class TechCardOut(BaseModel):
    item_id: int
    name: str
    kind_code: str
    kind_name: str
    source_type: str | None
    source_id: int | None
    operations: list[TechOperation]
    inputs: list[TechInput]
    used_in: list[TechUsage]
    # Плёнка: группа для складской части карточки (материал + цвет).
    material: str | None = None
    color: str | None = None
    thickness: float | None = None
    is_active: bool = True
    type_name: str | None = None
    type_id: int | None = None
    # Модель и варианты: is_model — это модель; model_* — модель варианта.
    is_model: bool = False
    model_id: int | None = None
    model_name: str | None = None



class ItemLookupOut(BaseModel):
    item_id: int


@router.get("/items/lookup", response_model=ItemLookupOut)
def lookup_item(
    part_id: int | None = Query(default=None),
    sku_id: int | None = Query(default=None),
    model_id: int | None = Query(default=None),
    material: str | None = Query(default=None),
    color: str | None = Query(default=None),
    thickness: float | None = Query(default=None),
    db: Session = Depends(get_db),
    user=Depends(view_items),
) -> ItemLookupOut:
    """Позиция номенклатуры за деталью / позицией плёнки / моделью — чтобы
    прежние переходы («открыть деталь») вели в одну карточку позиции."""
    item_id = None
    if part_id is not None:
        item_id = db.query(Part.item_id).filter(Part.id == part_id).scalar()
    elif sku_id is not None:
        item_id = db.query(MaterialSku.item_id).filter(MaterialSku.id == sku_id).scalar()
    elif model_id is not None:
        item_id = db.query(ProductModel.item_id).filter(ProductModel.id == model_id).scalar()
    elif material and color:
        # Группа плёнки (материал + цвет, толщина — если есть): карточка
        # материала показывает всю группу, позиция — активная первой.
        q = (
            db.query(MaterialSku)
            .join(MaterialSku.material)
            .join(MaterialSku.color)
            .filter(func.lower(Material.name) == material.lower(), func.lower(Color.name) == color.lower())
        )
        skus = q.all()
        if thickness is not None:
            skus = sorted(skus, key=lambda s: abs(float(s.thickness.value_mm) - thickness))
        skus = sorted(skus, key=lambda s: not s.is_active)
        item_id = skus[0].item_id if skus else None
    if item_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    return ItemLookupOut(item_id=item_id)


@router.get("/items/{item_id}/techcard", response_model=TechCardOut)
def get_techcard(item_id: int, db: Session = Depends(get_db), user=Depends(view_items)) -> TechCardOut:
    """Техкарта позиции — одна карточка на любой вид: маршрут (операции по
    участкам), состав (из чего состоит, общая спецификация item_components)
    и где используется. У детали п/ф в составе ещё и плёнка на штуку; у
    модели изделия — несвязанные строки BOM, чтобы ничего не пропало."""
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    kind = db.get(ItemKind, item.kind_id)
    area_names = {a.code: a.name for a in db.query(Area)}
    kinds = {k.id: k for k in db.query(ItemKind)}
    name, source_type, source_id = item.name, None, None
    inputs: list[TechInput] = []
    used_in: list[TechUsage] = []

    part = db.query(Part).filter(Part.item_id == item_id).first()
    model = db.query(ProductModel).filter(ProductModel.item_id == item_id).first() if part is None else None
    sku = (
        db.query(MaterialSku).filter(MaterialSku.item_id == item_id).first() if part is None and model is None else None
    )
    operations = [
        TechOperation(id=s.id, sequence_order=s.sequence_order, code=s.code, name=s.name, area=s.area, area_name=area_names.get(s.area), role=s.role)
        for s in item.stages
    ]
    stage_names = {s.id: s.name for s in item.stages}

    if part is not None:
        name, source_type, source_id = part.name, "part", part.id
        # Плёнка на штуку: штрипс шириной strip_width_mm длиной length_m.
        film = part.default_material_sku
        inputs.append(
            TechInput(
                name=(
                    sku_item_name(film.material.name, film.color.name, film.thickness.value_mm, film.manufacturer.name)
                    if film
                    else "Плёнка — выбирается в задании"
                ),
                part_id=None,
                qty_per_unit=float(part.length_m),
                unit="м",
                note=f"штрипс {_fmt(part.strip_width_mm)} мм" if part.strip_width_mm else None,
            )
        )
    elif model is not None:
        name, source_type, source_id = model.name, "model", model.id
    elif sku is not None:
        name, source_type, source_id = (
            sku_item_name(sku.material.name, sku.color.name, sku.thickness.value_mm, sku.manufacturer.name), "sku", sku.id
        )
        for p in db.query(Part).filter(Part.default_material_sku_id == sku.id).order_by(Part.name):
            used_in.append(
                TechUsage(name=p.name, source_type="part", source_id=p.id, qty_per_unit=float(p.length_m), item_id=p.item_id)
            )

    components = (
        db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id).order_by(ItemComponent.sort_order, ItemComponent.id).all()
    )
    parents = db.query(ItemComponent).filter(ItemComponent.component_item_id == item.id).all()
    names = live_item_names(db, {c.component_item_id for c in components} | {c.parent_item_id for c in parents})
    comp_items = {i.id: i for i in db.query(Item).filter(Item.id.in_([c.component_item_id for c in components]))} if components else {}
    comp_parts = {p.item_id: p for p in db.query(Part).filter(Part.item_id.in_(list(comp_items)))} if comp_items else {}
    for c in components:
        ci = comp_items.get(c.component_item_id)
        cp = comp_parts.get(c.component_item_id)
        inputs.append(
            TechInput(
                name=names.get(c.component_item_id, "—"), part_id=cp.id if cp else None,
                qty_per_unit=float(c.qty_per_unit), unit=(ci.unit or kinds[ci.kind_id].unit) if ci else "шт",
                note=f"{_fmt(cp.width_mm)}×{_fmt(round(float(cp.length_m) * 1000, 1))} мм" if cp else None,
                component_item_id=c.component_item_id, source=c.source, stage_id=c.stage_id,
                operation_name=stage_names.get(c.stage_id) if c.stage_id else None,
                alt_group=c.alt_group, from_defect=bool(c.from_defect),
            )
        )
    if model is not None:
        # Строки BOM, ещё не связанные с деталью, — в составе их пока нет.
        for b in model.parts:
            if b.part_id is None:
                inputs.append(
                    TechInput(
                        name=b.part_name or "—", part_id=None, qty_per_unit=float(b.qty_per_unit), unit="шт",
                        note=f"{_fmt(b.width_mm)}×{_fmt(round(float(b.length_m) * 1000, 1))} мм, {area_names.get(b.area, b.area)}",
                        source="bom",
                    )
                )
    parent_models = {m.item_id: m for m in db.query(ProductModel).filter(ProductModel.item_id.in_([c.parent_item_id for c in parents]))} if parents else {}
    parent_parts = {p.item_id: p for p in db.query(Part).filter(Part.item_id.in_([c.parent_item_id for c in parents]))} if parents else {}
    for c in sorted(parents, key=lambda c: names.get(c.parent_item_id, "").lower()):
        m = parent_models.get(c.parent_item_id)
        pp = parent_parts.get(c.parent_item_id)
        used_in.append(
            TechUsage(
                name=names.get(c.parent_item_id, "—"),
                source_type="model" if m else ("part" if pp else "item"),
                source_id=m.id if m else (pp.id if pp else c.parent_item_id),
                qty_per_unit=float(c.qty_per_unit), item_id=c.parent_item_id,
            )
        )

    active = (
        part.is_active if part is not None else model.is_active if model is not None else sku.is_active if sku is not None else item.is_active
    )
    return TechCardOut(
        item_id=item.id, name=name, kind_code=kind.code, kind_name=kind.name, source_type=source_type,
        source_id=source_id, operations=operations, inputs=inputs, used_in=used_in,
        material=sku.material.name if sku is not None else None, color=sku.color.name if sku is not None else None,
        thickness=float(sku.thickness.value_mm) if sku is not None else None, is_active=active,
        type_name=item.type.name if item.type else None, type_id=item.type_id,
        is_model=item.is_model, model_id=item.model_id,
        model_name=db.get(Item, item.model_id).name if item.model_id else None,
    )


class ComponentIn(BaseModel):
    component_item_id: int
    qty_per_unit: float = Field(gt=0)
    stage_id: int | None = None
    alt_group: int | None = None
    from_defect: bool = False


def _descendants(db: Session, item_id: int) -> set[int]:
    seen: set[int] = set()
    stack = [item_id]
    while stack:
        cur = stack.pop()
        for (cid,) in db.query(ItemComponent.component_item_id).filter(ItemComponent.parent_item_id == cur):
            if cid not in seen:
                seen.add(cid)
                stack.append(cid)
    return seen


@router.put("/items/{item_id}/components", response_model=TechCardOut)
def set_item_components(
    item_id: int, payload: list[ComponentIn], db: Session = Depends(get_db), user=Depends(link_lines)
) -> TechCardOut:
    """Ручной состав позиции (source="manual") целиком. Строки из BOM модели
    и по правилам типа здесь не трогаются — у них свой источник. Позиция не
    может входить в собственный состав, в том числе через другие позиции."""
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    stage_ids = {s.id for s in item.stages}
    for row in payload:
        comp = db.get(Item, row.component_item_id)
        if comp is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Компонент не найден")
        if comp.id == item.id or item.id in _descendants(db, comp.id):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"«{live_item_names(db, {comp.id}).get(comp.id)}» сам состоит из этой позиции — так состав зациклится",
            )
        if row.from_defect and db.query(Part.id).filter(Part.item_id == comp.id).first() is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"«{live_item_names(db, {comp.id}).get(comp.id)}» — не деталь п/ф: «только из брака» бывает только у деталей",
            )
        if row.stage_id is not None and row.stage_id not in stage_ids:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Операция не из маршрута этой позиции")
    db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id, ItemComponent.source == "manual").delete()
    base = db.query(func.coalesce(func.max(ItemComponent.sort_order), 0)).filter(ItemComponent.parent_item_id == item.id).scalar()
    for i, row in enumerate(payload, start=1):
        db.add(
            ItemComponent(
                parent_item_id=item.id, component_item_id=row.component_item_id, qty_per_unit=row.qty_per_unit,
                stage_id=row.stage_id, source="manual", sort_order=base + i,
                alt_group=row.alt_group, from_defect=row.from_defect,
            )
        )
    db.commit()
    return get_techcard(item_id, db, user)


class RouteStepIO(BaseModel):
    code: str
    name: str
    area: str | None = None
    role: str | None = "keep"  # вид операции (services/operation_roles); keep — не менять


def _role(role: str | None) -> str | None:
    from app.services.operation_roles import KEEP, clean_role

    if role == KEEP:
        return KEEP
    try:
        return clean_role(role)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e


@router.put("/items/{item_id}/route", response_model=list[TechOperation])
def set_item_route(
    item_id: int, payload: list[RouteStepIO], db: Session = Depends(get_db), user=Depends(link_lines)
) -> list[TechOperation]:
    """Маршрут любой позиции (пункт 3 единой модели): правка на месте, как у
    деталей п/ф (services/routes.py) — партии и история остаются на своих
    этапах, занятый этап удалить нельзя."""
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    # Без участка — только последняя операция («Готово» — общий запас).
    if any(not s.area for s in payload[:-1]):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Участок нужен у каждой операции, кроме последней («Готово» — общий запас)"
        )
    owner = db.query(Part).filter(Part.item_id == item.id).first() or item
    try:
        apply_route(db, owner, [RouteStep(code=s.code, name=s.name, area=s.area, role=_role(s.role)) for s in payload])
    except RouteInUseError as e:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    db.commit()
    db.refresh(item)
    area_names = {a.code: a.name for a in db.query(Area)}
    return [
        TechOperation(id=s.id, sequence_order=s.sequence_order, code=s.code, name=s.name, area=s.area, area_name=area_names.get(s.area), role=s.role)
        for s in item.stages
    ]
