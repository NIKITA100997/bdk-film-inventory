"""Конструктор моделей: новая модель (серия) типа, пачка вариантов с
предпросмотром и дерево техкарты для схемы (mindmap).

Подсказки — из того, что уже заведено по типу: какие размеры, цвета и
параметры серий встречаются чаще, — чтобы новую модель собирали выбором,
а не вспоминали цифры. Дерево — «взрыв» техкарты вглубь: позиция →
операции по участкам → что на каждой расходуется → у компонента свои
операции и состав. Для ещё не созданной позиции — по правилам типа, с
пометкой «будет создан»."""

from collections import Counter
from dataclasses import dataclass, field
from itertools import product

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.dictionaries import Part
from app.models.items import Item, ItemComponent, ItemProperty, ItemPropertyOption, ItemPropertyValue, ItemType
from app.services import type_rules
from app.services.components import live_item_names

MAX_DEPTH = 6
MAX_BATCH = 300


# ─── подсказки ────────────────────────────────────────────────────────────


def value_hints(db: Session, type_: ItemType, top: int = 12) -> dict:
    """Частые значения свойств у вариантов типа и частые параметры серий:
    {"properties": {prop_id: [{value, count}]}, "option_fields": {prop_id:
    {field_code: [{value, count}]}}}. Значение списка — id варианта."""
    item_ids = [i for (i,) in db.query(Item.id).filter(Item.type_id == type_.id, Item.is_model.is_(False))]
    props: dict[int, list[dict]] = {}
    fields: dict[int, dict[str, list[dict]]] = {}
    for p in type_.properties:
        if p.value_type == "bool":
            continue
        counts: Counter = Counter()
        if item_ids:
            for v in db.query(ItemPropertyValue).filter(
                ItemPropertyValue.property_id == p.id, ItemPropertyValue.item_id.in_(item_ids)
            ):
                raw = {"number": v.value_number, "text": v.value_text, "list": v.option_id}[p.value_type]
                if raw not in (None, ""):
                    counts[float(raw) if p.value_type == "number" else raw] += 1
        props[p.id] = [
            {"value": int(k) if isinstance(k, float) and k.is_integer() else k, "count": n}
            for k, n in counts.most_common(top)
        ]
        if p.value_type == "list" and p.option_fields:
            per_field: dict[str, Counter] = {f["code"]: Counter() for f in p.option_fields}
            for o in p.options:
                for code, val in (o.params or {}).items():
                    if code in per_field and val not in (None, ""):
                        per_field[code][val] += 1
            fields[p.id] = {
                code: [{"value": k, "count": n} for k, n in c.most_common(top)] for code, c in per_field.items()
            }
    return {"properties": props, "option_fields": fields}


# ─── новая модель ─────────────────────────────────────────────────────────


def ensure_model(db: Session, type_: ItemType, option: ItemPropertyOption) -> Item:
    """Позиция-модель для варианта свойства-модели («Щитовая дверь В-11»):
    есть — вернуть, нет — завести (без commit)."""
    model = (
        db.query(Item)
        .join(ItemPropertyValue, ItemPropertyValue.item_id == Item.id)
        .filter(
            Item.is_model.is_(True), Item.type_id == type_.id,
            ItemPropertyValue.property_id == option.property_id, ItemPropertyValue.option_id == option.id,
        )
        .first()
    )
    if model is None:
        model = Item(kind_id=type_.kind_id, name=f"{type_.name} {option.value}"[:255], type_id=type_.id, is_model=True)
        db.add(model)
        db.flush()
        db.add(ItemPropertyValue(item_id=model.id, property_id=option.property_id, option_id=option.id))
        db.flush()
    return model


def add_model(db: Session, type_: ItemType, value: str, params: dict) -> tuple[ItemPropertyOption, Item]:
    """Новая модель типа: вариант свойства-модели с параметрами серии и
    позиция-модель (без commit). ValueError — понятная причина."""
    prop: ItemProperty | None = next((p for p in type_.properties if p.id == type_.model_property_id), None)
    if prop is None:
        raise ValueError(f"У типа «{type_.name}» нет моделей — варианты заводятся без модели")
    value = " ".join(value.split())
    if not value:
        raise ValueError("Укажите название модели")
    if any(o.value.strip().lower() == value.lower() for o in prop.options):
        raise ValueError(f"Модель «{value}» уже есть — добавьте ей варианты")
    codes = {f["code"]: f for f in (prop.option_fields or [])}
    clean = {}
    for code, raw in (params or {}).items():
        if code not in codes or raw in (None, ""):
            continue
        if codes[code].get("value_type", "number") == "number":
            try:
                clean[code] = float(raw)
            except (TypeError, ValueError) as e:
                raise ValueError(f"«{codes[code]['name']}» — число") from e
        else:
            clean[code] = str(raw).strip()
    missing = [f["name"] for code, f in codes.items() if code not in clean]
    if missing:
        raise ValueError("Заполните параметры модели: " + ", ".join(missing))
    option = ItemPropertyOption(value=value, params=clean, is_active=True, sort_order=len(prop.options) + 1)
    prop.options.append(option)
    db.flush()
    return option, ensure_model(db, type_, option)


# ─── пачка вариантов ──────────────────────────────────────────────────────


@dataclass
class BatchRow:
    values: dict[int, object]
    name: str | None = None
    status: str = "new"  # new | exists | error | created
    item_id: int | None = None
    errors: list[str] = field(default_factory=list)


def combinations(type_: ItemType, choices: dict[int, list]) -> list[dict[int, object]]:
    """Все сочетания выбранных значений свойств (у свойства без выбора —
    пусто). Порядок — как свойства у типа."""
    props = [p for p in type_.properties]
    lists = [choices.get(p.id) or [None] for p in props]
    out = []
    for combo in product(*lists):
        out.append({p.id: v for p, v in zip(props, combo) if v not in (None, "")})
    return out


def batch(db: Session, type_: ItemType, rows: list[dict[int, object]], *, create: bool) -> list[BatchRow]:
    """Предпросмотр (create=False: название, есть ли уже, ошибки правил —
    ничего не пишет) или создание вариантов пачкой: каждый — в своём
    savepoint, ошибка одного не мешает остальным (без commit)."""
    out: list[BatchRow] = []
    seen: set[str] = set()
    for values in rows[:MAX_BATCH]:
        row = BatchRow(values=values)
        if create:
            item, created, errors = type_rules.ensure_item(db, type_, values)
            row.errors = errors
            if item is not None:
                row.name, row.item_id, row.status = item.name, item.id, "created" if created else "exists"
            else:
                row.status = "error"
        else:
            missing = [p.name for p in type_.properties if p.is_required and p.value_type != "bool" and values.get(p.id) in (None, "")]
            if missing:
                row.status, row.errors = "error", ["Не заполнено: " + ", ".join(missing)]
            else:
                res = type_rules.compute(db, type_, type_rules.context_from_values(db, type_, values))
                row.name, row.errors = res.name, res.errors
                if res.errors:
                    row.status = "error"
                elif res.name:
                    existing = (
                        db.query(Item)
                        .filter(Item.kind_id == type_.kind_id, func.lower(Item.name) == res.name.lower())
                        .first()
                    )
                    if existing is not None:
                        row.status, row.item_id = "exists", existing.id
            if row.name and row.status == "new":
                if row.name.lower() in seen:
                    row.status, row.errors = "error", ["Такое же название у другой строки — шаблон названия их не различает"]
                seen.add(row.name.lower())
        out.append(row)
    return out


# ─── дерево техкарты ──────────────────────────────────────────────────────


@dataclass
class TreeNode:
    name: str
    kind_code: str | None
    item_id: int | None
    exists: bool
    qty: float | None = None
    unit: str | None = None
    operations: list["TreeOperation"] = field(default_factory=list)
    loose: list["TreeNode"] = field(default_factory=list)  # состав без маршрута
    warnings: list[str] = field(default_factory=list)
    film: str | None = None  # закреплённая плёнка детали


@dataclass
class TreeOperation:
    name: str
    area: str | None
    area_name: str | None
    components: list[TreeNode] = field(default_factory=list)


def _areas(db: Session) -> dict[str, str]:
    return {a.code: a.name for a in db.query(Area)}


def item_tree(db: Session, item: Item, *, qty: float | None = None, depth: int = 0, areas: dict | None = None) -> TreeNode:
    """Дерево существующей позиции по её техкарте."""
    areas = areas if areas is not None else _areas(db)
    names = live_item_names(db, {item.id})
    node = TreeNode(
        name=names.get(item.id, item.name), kind_code=item.kind.code, item_id=item.id, exists=True, qty=qty,
        unit=item.unit or item.kind.unit,
    )
    if depth >= MAX_DEPTH:
        node.warnings.append("дальше не раскрыто — слишком глубоко")
        return node
    stages = sorted(item.stages, key=lambda s: s.sequence_order)
    comps = (
        db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id).order_by(ItemComponent.sort_order).all()
    )
    ops = [TreeOperation(name=s.name, area=s.area, area_name=areas.get(s.area) if s.area else None) for s in stages]
    by_stage = {s.id: op for s, op in zip(stages, ops)}
    for c in comps:
        child = db.get(Item, c.component_item_id)
        if child is None:
            continue
        sub = item_tree(db, child, qty=float(c.qty_per_unit), depth=depth + 1, areas=areas)
        target = by_stage.get(c.stage_id) if c.stage_id else (ops[0] if ops else None)
        if target is not None:
            target.components.append(sub)
        else:
            node.loose.append(sub)
    node.operations = ops
    if item.kind.code in ("pf", "izdelie") and not stages and not item.is_model:
        node.warnings.append(
            "нет маршрута — в заказ не запустится"
            if depth == 0
            else "нет маршрута — партии не ведутся, в «Потребность п/ф» не попадёт"
        )
    for op in ops:
        if op.area is None and op is not ops[-1]:
            node.warnings.append(f"у операции «{op.name}» не указан участок")
    # Деталь с цветом — какая плёнка на неё закреплена.
    part = db.query(Part).filter(Part.item_id == item.id).first()
    if part is not None and item.type is not None and any(p.code == type_rules.COLOR_CODE for p in item.type.properties):
        sku = part.default_material_sku
        if sku is not None:
            node.film = f"{sku.material.name}, {sku.color.name}, {float(sku.thickness.value_mm):g} мм, {sku.manufacturer.name}"
        elif any(getattr(s, "role", None) == "film" for s in stages):
            n = len(type_rules.film_candidates(db, type_rules.item_values_color(db, item) or ""))
            node.warnings.append(
                "плёнка не закреплена — выберите у детали" + (f" (подходит {n})" if n > 1 else " (по цвету не нашлась)")
            )
    return node


def preview_tree(db: Session, type_: ItemType, values: dict[int, object], *, qty: float | None = None, depth: int = 0,
                 areas: dict | None = None) -> TreeNode:
    """Дерево позиции, которой ещё нет, — по правилам типа; компоненты,
    которые уже есть, раскрываются по их техкарте."""
    areas = areas if areas is not None else _areas(db)
    res = type_rules.compute(db, type_, type_rules.context_from_values(db, type_, values))
    node = TreeNode(name=res.name or f"(новая позиция — {type_.name})", kind_code=type_.kind.code, item_id=None,
                    exists=False, qty=qty, unit=type_.kind.unit, warnings=list(res.errors))
    ops = [TreeOperation(name=n, area=a, area_name=areas.get(a) if a else None) for n, a in res.operations]
    node.operations = ops
    if not ops and type_.kind.code in ("pf", "izdelie"):
        node.warnings.append("по правилам типа нет ни одной операции — в заказ не запустится")
    if depth >= MAX_DEPTH:
        return node
    by_name = {op.name: op for op in ops}
    for c in res.components:
        if c.existing_item_id is not None:
            sub = item_tree(db, db.get(Item, c.existing_item_id), qty=c.qty, depth=depth + 1, areas=areas)
        elif c.child_type_id is not None:
            sub = preview_tree(db, db.get(ItemType, c.child_type_id), c.child_values or {}, qty=c.qty, depth=depth + 1,
                               areas=areas)
        else:
            sub = TreeNode(name=c.name, kind_code="pf", item_id=None, exists=False, qty=c.qty, unit="шт")
        target = by_name.get(c.operation_name) if c.operation_name else (ops[0] if ops else None)
        if target is not None:
            target.components.append(sub)
        else:
            node.loose.append(sub)
    return node


def option_label(db: Session, option_id: int) -> str | None:
    opt = db.get(ItemPropertyOption, option_id)
    return opt.value if opt else None
