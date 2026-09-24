from collections import defaultdict
from difflib import SequenceMatcher

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.core.security import require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import MaterialSku, Part
from app.models.items import Item, ItemComponent, ItemKind, fmt_num as _fmt, normalize_name, size_part_name, sku_item_name
from app.models.production import ProductionTask, ProductionTaskLine, ProductModel, ProductModelPart
from app.services.components import live_item_names, sync_bom_components
from app.services.routes import RouteInUseError, RouteStep, apply_route

router = APIRouter(tags=["items"])

view_items = require_permission(
    "materials.manage", "production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view"
)
link_lines = require_permission("production_tasks.manage")


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
    material: str | None = None
    color: str | None = None
    thickness: float | None = None


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
                id=item.id, kind_code=kind.code, kind_name=kind.name, unit=kind.unit, name=name,
                code_1c=item.code_1c, is_active=active, source_type=source_type, source_id=source_id, **extra,
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
                    id=item.id, kind_code=item_kind.code, kind_name=item_kind.name, unit=item_kind.unit, name=item.name,
                    code_1c=item.code_1c, is_active=item.is_active, source_type=None, source_id=None,
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


def _suggest(name: str, parts: list[Part]) -> list[PartSuggestion]:
    key = normalize_name(name)
    scored = sorted(
        ((SequenceMatcher(None, key, normalize_name(p.name)).ratio(), p) for p in parts),
        key=lambda x: x[0],
        reverse=True,
    )
    return [PartSuggestion(part_id=p.id, part_name=p.name, score=round(r, 2)) for r, p in scored[:3] if r >= 0.5]


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
        db.query(ProductionTaskLine.part_name, ProductionTask.is_active)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTaskLine.part_name.isnot(None), ProductionTaskLine.part_id.is_(None))
    )
    for name, active in rows:
        g = groups[normalize_name(name)]
        g["task"] += 1
        g["active"] += 1 if active else 0
        g["name"] = g["name"] or name
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
            if normalize_name(line.part_name) == key:
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
        route = [RouteStep(code=s.code, name=s.name, area=s.area) for s in template.stages]
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



class ItemLookupOut(BaseModel):
    item_id: int


@router.get("/items/lookup", response_model=ItemLookupOut)
def lookup_item(
    part_id: int | None = Query(default=None),
    sku_id: int | None = Query(default=None),
    model_id: int | None = Query(default=None),
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
        TechOperation(id=s.id, sequence_order=s.sequence_order, code=s.code, name=s.name, area=s.area, area_name=area_names.get(s.area))
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
                qty_per_unit=float(c.qty_per_unit), unit=kinds[ci.kind_id].unit if ci else "шт",
                note=f"{_fmt(cp.width_mm)}×{_fmt(round(float(cp.length_m) * 1000, 1))} мм" if cp else None,
                component_item_id=c.component_item_id, source=c.source, stage_id=c.stage_id,
                operation_name=stage_names.get(c.stage_id) if c.stage_id else None,
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
        type_name=item.type.name if item.type else None,
    )


class ComponentIn(BaseModel):
    component_item_id: int
    qty_per_unit: float = Field(gt=0)
    stage_id: int | None = None


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
        if row.stage_id is not None and row.stage_id not in stage_ids:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Операция не из маршрута этой позиции")
    db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id, ItemComponent.source == "manual").delete()
    base = db.query(func.coalesce(func.max(ItemComponent.sort_order), 0)).filter(ItemComponent.parent_item_id == item.id).scalar()
    for i, row in enumerate(payload, start=1):
        db.add(
            ItemComponent(
                parent_item_id=item.id, component_item_id=row.component_item_id, qty_per_unit=row.qty_per_unit,
                stage_id=row.stage_id, source="manual", sort_order=base + i,
            )
        )
    db.commit()
    return get_techcard(item_id, db, user)


class RouteStepIO(BaseModel):
    code: str
    name: str
    area: str | None = None


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
    if any(not s.area for s in payload):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "У каждой операции должен быть участок")
    owner = db.query(Part).filter(Part.item_id == item.id).first() or item
    try:
        apply_route(db, owner, [RouteStep(code=s.code, name=s.name, area=s.area) for s in payload])
    except RouteInUseError as e:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    db.commit()
    db.refresh(item)
    area_names = {a.code: a.name for a in db.query(Area)}
    return [
        TechOperation(id=s.id, sequence_order=s.sequence_order, code=s.code, name=s.name, area=s.area, area_name=area_names.get(s.area))
        for s in item.stages
    ]
