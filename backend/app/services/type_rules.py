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
    KIND_PF,
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
    # Компонент со своим типом: тип и значения его свойств (property_id → значение).
    child_type_id: int | None = None
    child_values: dict | None = None


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
        if (raw is None or raw == "") and p.value_type == "bool":
            ctx[p.code] = False  # неотмеченный флажок — «нет», а не «не заполнено»
        elif (raw is None or raw == "") and p.value_type == "text" and not p.is_required:
            ctx[p.code] = ""  # необязательный текст пуст — «нет» (стекло без вида и т.п.)
        elif raw is None or raw == "":
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


def _child_values(db: Session, child_type: ItemType, exprs: dict, ctx: dict) -> dict[int, object]:
    """Значения свойств компонента по формулам от свойств родителя."""
    from app.services.expressions import evaluate

    out: dict[int, object] = {}
    props = {p.code: p for p in child_type.properties}
    for code, expr in (exprs or {}).items():
        p = props.get(code)
        if p is None or not str(expr).strip():
            continue
        v = evaluate(str(expr), ctx)
        if p.value_type == "list":
            text = v.value if isinstance(v, OptionRef) else str(v)
            opt = next((o for o in p.options if o.value.strip().lower() == text.strip().lower()), None)
            if opt is None:
                raise ExpressionError(f"У «{child_type.name}» в списке «{p.name}» нет варианта «{text}»")
            out[p.id] = opt.id
        elif p.value_type == "number":
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise ExpressionError(f"«{p.name}» у «{child_type.name}» — число, а формула дала «{v}»")
            out[p.id] = float(v)
        elif p.value_type == "bool":
            out[p.id] = bool(v)
        else:
            out[p.id] = str(v)
    return out


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
        child_type = None
        try:
            if not evaluate_condition(rule.condition, ctx):
                continue
            child_type = db.get(ItemType, rule.component_type_id) if rule.component_type_id else None
            child_values = None
            if child_type is not None:
                # Компонент со своим типом — название по шаблону ЕГО типа.
                child_values = _child_values(db, child_type, rule.component_values or {}, ctx)
                if not child_type.name_template:
                    raise ExpressionError(f"у типа «{child_type.name}» не задан шаблон названия")
                name = render_template(child_type.name_template, context_from_values(db, child_type, child_values))
            else:
                name = render_template(rule.name_template, ctx)
            qty = evaluate_number(rule.qty_expr or "1", ctx)
            width = evaluate_number(rule.width_expr, ctx) if rule.width_expr else None
            length = evaluate_number(rule.length_expr, ctx) if rule.length_expr else None
            strip = evaluate_number(rule.strip_width_expr, ctx) if rule.strip_width_expr else None
        except ExpressionError as e:
            res.errors.append(f"Состав «{rule.name_template or (child_type.name if child_type else '')}»: {e}")
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
                child_type_id=child_type.id if child_type else None, child_values=child_values,
            )
        )
        if part is None and existing_item is None and (width is None or length is None):
            res.errors.append(f"«{name}»: такой позиции нет, а размеры для её создания в правиле не заданы")
    return res


def _set_values(db: Session, item: Item, type_: ItemType, values: dict[int, object]) -> None:
    item.type_id = type_.id
    db.query(ItemPropertyValue).filter(ItemPropertyValue.item_id == item.id).delete()
    props = {p.id: p for p in type_.properties}
    for pid, raw in values.items():
        p = props[pid]
        v = ItemPropertyValue(item_id=item.id, property_id=pid)
        if p.value_type == "number":
            v.value_number = raw
        elif p.value_type == "bool":
            v.value_bool = raw
        elif p.value_type == "list":
            v.option_id = raw
        else:
            v.value_text = raw
        db.add(v)
    db.flush()
    db.refresh(item)


def apply(db: Session, item: Item, _depth: int = 0) -> RulesResult:
    """Применить правила типа позиции (без commit). При ошибках в данных
    самой позиции — ничего не пишет и возвращает их; ошибки компонентов со
    своим типом тоже возвращаются — вызывающий код откатывает всё
    (везде применение идёт в savepoint или с rollback)."""
    if _depth > 5:
        return RulesResult(errors=["Слишком глубокая вложенность типов компонентов — проверьте, нет ли цикла"])
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
            if c.child_type_id is not None:
                # Компонент со своим типом: тип, значения свойств и его
                # собственные правила (маршрут, состав) — вглубь.
                child = db.get(Item, comp_item_id)
                _set_values(db, child, db.get(ItemType, c.child_type_id), c.child_values or {})
                guess_group(db, child)
                sub = apply(db, child, _depth + 1)
                if sub.errors:
                    res.errors.extend(f"«{c.name}»: {e}" for e in sub.errors)
                    return res
            db.add(
                ItemComponent(
                    parent_item_id=item.id, component_item_id=comp_item_id, qty_per_unit=c.qty,
                    stage_id=stage_by_name.get(c.operation_name) if c.operation_name else None,
                    source="rule", rule_id=c.rule_id, sort_order=1000 + i,
                )
            )
        db.flush()
    return res


def link_model(db: Session, item: Item) -> Item | None:
    """Вариант → его модель («Щитовая дверь В-9»): по значению свойства,
    задающего модель у типа. Модели нет — заводится (без commit). У типа
    без моделей или у позиции без этого значения — ссылка снимается."""
    type_ = item.type
    prop = next((p for p in type_.properties if p.id == type_.model_property_id), None) if type_ else None
    value = (
        db.query(ItemPropertyValue)
        .filter(ItemPropertyValue.item_id == item.id, ItemPropertyValue.property_id == prop.id)
        .first()
        if prop is not None and not item.is_model
        else None
    )
    if value is None or value.option_id is None:
        item.model_id = None
        return None
    model = (
        db.query(Item)
        .join(ItemPropertyValue, ItemPropertyValue.item_id == Item.id)
        .filter(
            Item.is_model.is_(True), Item.type_id == type_.id,
            ItemPropertyValue.property_id == prop.id, ItemPropertyValue.option_id == value.option_id,
        )
        .first()
    )
    if model is None:
        opt = db.get(ItemPropertyOption, value.option_id)
        model = Item(kind_id=item.kind_id, name=f"{type_.name} {opt.value}"[:255], type_id=type_.id, is_model=True)
        db.add(model)
        db.flush()
        db.add(ItemPropertyValue(item_id=model.id, property_id=prop.id, option_id=opt.id))
        db.flush()
    item.model_id = model.id
    return model


def guess_group(db: Session, item: Item) -> None:
    """Группа новой позиции без группы — как у позиций того же типа с теми же
    вариантами свойств-списков (линия «МК» → «МК / Детали»): самая частая
    среди них. Не нашлось — остаётся без группы."""
    if item.group_id is not None or item.type is None:
        return
    lists = [p.id for p in item.type.properties if p.value_type == "list"]
    mine = {
        v.property_id: v.option_id
        for v in db.query(ItemPropertyValue).filter(ItemPropertyValue.item_id == item.id, ItemPropertyValue.property_id.in_(lists))
    }
    q = db.query(Item.group_id, func.count(Item.id)).filter(
        Item.type_id == item.type_id, Item.id != item.id, Item.group_id.isnot(None), Item.is_model.is_(False)
    )
    for pid, oid in mine.items():
        q = q.filter(Item.id.in_(
            db.query(ItemPropertyValue.item_id).filter(ItemPropertyValue.property_id == pid, ItemPropertyValue.option_id == oid)
        ))
    best = q.group_by(Item.group_id).order_by(func.count(Item.id).desc()).first()
    if best is not None:
        item.group_id = best[0]


def property_codes(type_: ItemType) -> set[str]:
    return {p.code for p in type_.properties}


def list_param_codes(type_: ItemType) -> dict[str, set[str]]:
    return {p.code: {f["code"] for f in (p.option_fields or [])} for p in type_.properties if p.value_type == "list"}



def ensure_item(db: Session, type_: ItemType, values: dict[int, object]) -> tuple[Item | None, bool, list[str]]:
    """Позиция по типу и значениям свойств (без commit): название — по
    шаблону типа, техкарта — по его правилам. Такая позиция уже есть —
    вернуть её (одна позиция на сочетание свойств). Возвращает (позиция,
    создана ли, ошибки); при ошибках позиция None и ничего не записано —
    внутри savepoint."""
    from sqlalchemy import func as _func

    if not type_.name_template:
        return None, False, ["У типа не задан шаблон названия позиции"]
    missing = [p.name for p in type_.properties if p.is_required and p.value_type != "bool" and values.get(p.id) in (None, "")]
    if missing:
        return None, False, ["Не заполнено: " + ", ".join(missing)]
    res = compute(db, type_, context_from_values(db, type_, values))
    if res.errors:
        return None, False, res.errors
    existing = db.query(Item).filter(Item.kind_id == type_.kind_id, _func.lower(Item.name) == res.name.lower()).first()
    if existing is not None:
        return existing, False, []
    sp = db.begin_nested()
    if type_.kind.code == KIND_PF:
        # П/ф ведётся партиями через деталь (Part) — заводим её, позиция
        # номенклатуры появится сама. Ширина/длина — из свойств (мм); крой
        # плёнки (длина с припуском, штрипс) правится в «Деталях п/ф».
        ctx = context_from_values(db, type_, values)
        width = ctx.get("ширина")
        length = ctx.get("длина") if ctx.get("длина") is not None else ctx.get("высота")
        part = Part(
            name=res.name, width_mm=float(width or 0), length_m=round(float(length or 0) / 1000, 3), is_active=True,
        )
        db.add(part)
        db.flush()
        item = part.item
        item.type_id = type_.id
    else:
        item = Item(kind_id=type_.kind_id, name=res.name, type_id=type_.id)
        db.add(item)
    db.flush()
    _set_values(db, item, type_, {pid: v for pid, v in values.items() if v not in (None, "")})
    applied = apply(db, item)
    if applied.errors:
        sp.rollback()
        return None, False, applied.errors
    link_model(db, item)
    guess_group(db, item)
    db.flush()
    sp.commit()
    return item, True, []
