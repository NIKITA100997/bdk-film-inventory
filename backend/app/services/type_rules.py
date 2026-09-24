"""Правила типа изделия → техкарта позиции (единая модель, пункт 3).

По свойствам позиции:
  • название — по шаблону типа (только у позиций без своей таблицы;
    деталь п/ф и модель изделия называются в своих справочниках);
  • маршрут — операции типа, чьё условие верно;
  • состав "rule" — по правилам состава: позиция п/ф с названием по
    шаблону находится или заводится сама (с размерами по формулам и
    маршрутом как у детали-образца).
compute() ничего не пишет (проверка перед сохранением), apply() пишет всё
разом; при ошибке в данных не меняется ничего."""

from dataclasses import dataclass, field

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.dictionaries import Part
from app.models.items import (
    Item,
    ItemComponent,
    ItemPropertyOption,
    ItemPropertyValue,
    ItemType,
    normalize_name,
)
from app.services.expressions import (
    ExpressionError,
    OptionRef,
    evaluate_condition,
    evaluate_number,
    render_template,
)
from app.services.routes import RouteStep, apply_route


@dataclass
class PlannedComponent:
    rule_id: int
    name: str
    qty: float
    width_mm: float | None
    length_mm: float | None
    strip_width_mm: float | None
    operation_name: str | None
    existing_part_id: int | None
    existing_item_id: int | None


@dataclass
class RulesResult:
    name: str | None = None
    operations: list[tuple[str, str]] = field(default_factory=list)  # (название, участок)
    components: list[PlannedComponent] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def context_from_values(db: Session, type_: ItemType, values: dict[int, object]) -> dict:
    """Свойства → переменные формул: код свойства → число / текст / да-нет /
    вариант списка (OptionRef с параметрами)."""
    ctx: dict = {}
    for p in type_.properties:
        raw = values.get(p.id)
        if raw is None or raw == "":
            ctx[p.code] = None
        elif p.value_type == "list":
            opt = db.get(ItemPropertyOption, int(raw))
            ctx[p.code] = OptionRef(opt.value, dict(opt.params or {})) if opt else None
        elif p.value_type == "number":
            ctx[p.code] = float(raw)
        elif p.value_type == "bool":
            ctx[p.code] = bool(raw)
        else:
            ctx[p.code] = str(raw)
    return ctx


def item_values(db: Session, item: Item) -> dict[int, object]:
    out: dict[int, object] = {}
    props = {p.id: p for p in (item.type.properties if item.type else [])}
    for v in db.query(ItemPropertyValue).filter(ItemPropertyValue.item_id == item.id):
        p = props.get(v.property_id)
        if p is None:
            continue
        out[p.id] = {
            "number": float(v.value_number) if v.value_number is not None else None,
            "text": v.value_text,
            "bool": v.value_bool,
            "list": v.option_id,
        }[p.value_type]
    return out


def _find_part(db: Session, name: str) -> Part | None:
    key = normalize_name(name)
    return (
        db.query(Part)
        .filter(func.replace(func.lower(func.trim(Part.name)), "ё", "е") == key)
        .order_by(Part.id)
        .first()
    )


def compute(db: Session, type_: ItemType, ctx: dict) -> RulesResult:
    res = RulesResult()
    if type_.name_template:
        try:
            res.name = render_template(type_.name_template, ctx)
        except ExpressionError as e:
            res.errors.append(f"Название: {e}")
    for op in type_.operations:
        try:
            if evaluate_condition(op.condition, ctx):
                res.operations.append((op.name, op.area))
        except ExpressionError as e:
            res.errors.append(f"Операция «{op.name}»: {e}")
    for rule in type_.component_rules:
        try:
            if not evaluate_condition(rule.condition, ctx):
                continue
            name = render_template(rule.name_template, ctx)
            qty = evaluate_number(rule.qty_expr or "1", ctx)
            width = evaluate_number(rule.width_expr, ctx) if rule.width_expr else None
            length = evaluate_number(rule.length_expr, ctx) if rule.length_expr else None
            strip = evaluate_number(rule.strip_width_expr, ctx) if rule.strip_width_expr else None
        except ExpressionError as e:
            res.errors.append(f"Состав «{rule.name_template}»: {e}")
            continue
        if qty <= 0:
            continue
        part = _find_part(db, name)
        existing_item = None
        if part is None:
            existing_item = db.query(Item).filter(func.lower(Item.name) == name.lower()).first()
        res.components.append(
            PlannedComponent(
                rule_id=rule.id, name=name, qty=qty, width_mm=width, length_mm=length, strip_width_mm=strip,
                operation_name=rule.operation_name, existing_part_id=part.id if part else None,
                existing_item_id=part.item_id if part else (existing_item.id if existing_item else None),
            )
        )
        if part is None and existing_item is None and (width is None or length is None):
            res.errors.append(f"«{name}»: такой позиции нет, а размеры для её создания в правиле не заданы")
    return res


def apply(db: Session, item: Item) -> RulesResult:
    """Применить правила типа позиции (без commit). При ошибках — ничего не
    пишет и возвращает их."""
    type_ = item.type
    if type_ is None:
        return RulesResult()
    ctx = context_from_values(db, type_, item_values(db, item))
    res = compute(db, type_, ctx)
    if res.errors:
        return res
    has_rules = bool(type_.operations or type_.component_rules)

    # Название — только у позиции без своей таблицы.
    part_owner = db.query(Part).filter(Part.item_id == item.id).first()
    from app.models.production import ProductModel

    own_table = part_owner is not None or db.query(ProductModel.id).filter(ProductModel.item_id == item.id).first()
    if res.name and not own_table:
        item.name = res.name

    if has_rules:
        # Маршрут: code = название операции — ключ сопоставления, партии и
        # история остаются на своих операциях (services/routes.py).
        apply_route(db, part_owner or item, [RouteStep(code=n, name=n, area=a) for n, a in res.operations])
        db.flush()
        stage_by_name = {s.name: s.id for s in item.stages}

        db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id, ItemComponent.source == "rule").delete()
        for i, c in enumerate(res.components, start=1):
            comp_item_id = c.existing_item_id
            if comp_item_id is None:
                # Два правила с одним названием — позиция заводится один раз.
                again = _find_part(db, c.name)
                comp_item_id = again.item_id if again else None
            if comp_item_id is None:
                rule = next(r for r in type_.component_rules if r.id == c.rule_id)
                part = Part(
                    name=c.name, width_mm=c.width_mm, length_m=round(c.length_mm / 1000, 3),
                    strip_width_mm=c.strip_width_mm, is_active=True,
                )
                db.add(part)
                db.flush()
                if rule.route_part_id:
                    template = db.get(Part, rule.route_part_id)
                    if template is not None:
                        apply_route(db, part, [RouteStep(code=s.code, name=s.name, area=s.area) for s in template.stages])
                        part.area = template.area
                db.flush()
                comp_item_id = part.item_id
            db.add(
                ItemComponent(
                    parent_item_id=item.id, component_item_id=comp_item_id, qty_per_unit=c.qty,
                    stage_id=stage_by_name.get(c.operation_name) if c.operation_name else None,
                    source="rule", rule_id=c.rule_id, sort_order=1000 + i,
                )
            )
        db.flush()
    return res


def property_codes(type_: ItemType) -> set[str]:
    return {p.code for p in type_.properties}


def list_param_codes(type_: ItemType) -> dict[str, set[str]]:
    return {p.code: {f["code"] for f in (p.option_fields or [])} for p in type_.properties if p.value_type == "list"}

