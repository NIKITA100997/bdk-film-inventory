from collections import defaultdict
from difflib import SequenceMatcher

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from app.core.security import require_permission
from app.db.session import get_db
from app.models.dictionaries import MaterialSku, Part
from app.models.items import Item, ItemKind, fmt_num as _fmt, normalize_name, size_part_name, sku_item_name
from app.models.production import ProductionTask, ProductionTaskLine, ProductModel, ProductModelPart
from app.services.routes import RouteStep, apply_route

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
            kind = kinds[item.kind_id]
            out.append(
                ItemOut(
                    id=item.id, kind_code=kind.code, kind_name=kind.name, unit=kind.unit, name=item.name,
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
    for model, label in ((ProductModelPart, "bom"), (ProductionTaskLine, "task")):
        for line in db.query(model).filter(model.part_name.isnot(None), model.part_id.is_(None)):
            if normalize_name(line.part_name) == key:
                line.part_id = part.id
                counts[label] += 1
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
    for model, label in ((ProductModelPart, "bom"), (ProductionTaskLine, "task")):
        for line in db.query(model).filter(model.part_id == payload.part_id, model.part_name.isnot(None)):
            if normalize_name(line.part_name) == key:
                line.part_id = None
                counts[label] += 1
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
    db.commit()
    return SizeCreateOut(created=created, linked_existing=linked_existing, bom_lines=bom, task_lines=task)
