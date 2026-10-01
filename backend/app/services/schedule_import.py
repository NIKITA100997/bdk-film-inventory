"""Импорт графика запуска щитовых дверей в заказ на производство (единая
модель). Разбор строк — services/shield_schedule.py; здесь строка графика
становится значениями свойств типа «Щитовая дверь» (по кодам свойств:
серия, ширина, высота, цвет, стекло, молдинг, замок, кромка, цвет_кромки), позиция
находится или создаётся по типу, строка — строкой заказа."""

import re
from dataclasses import dataclass, field

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.items import Item, ItemType
from app.models.production_orders import ORDER_DRAFT, ProductionOrder, ProductionOrderLine
from app.services import type_rules
from app.services.shield_schedule import ScheduleRow, parse_line_features, parse_pasted_schedule, parse_size, series_key

_ROW_NOTES: list[str] = []  # пометки разбора текущей строки (новый цвет и т.п.)
REQUIRED_CODES = ("серия", "ширина", "высота", "цвет", "стекло", "молдинг", "замок", "кромка", "цвет_кромки")


@dataclass
class ImportRow:
    series: str
    size: str
    color: str
    name_text: str
    qty: int
    invoice_no: str
    ship_date: str | None
    item_name: str | None = None
    exists: bool = False
    item_id: int | None = None
    errors: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def color_from_name(name_text: str, color_text: str) -> str:
    """Цвет двери из наименования строки графика: «В-10.2 (…) 800х2000 -
    ПЭТ Бежевый (cream silk) кромка черная ABS 2мм» → «ПЭТ Бежевый (cream
    silk)». Модель — серия, цвет — отдельно (решение 01.10). Не разобрали —
    колонка «Цвет»."""
    tail = name_text.split(" - ", 1)[1] if " - " in name_text else ""
    tail = re.split(r"\s+кромка\b|\s+\(стекло|\s+\(Защелка|\s+\(защелка", tail, maxsplit=1)[0]
    # Скобки с фурнитурой — не цвет: «(PL410 + петли AGB Eclipse 3.0)».
    tail = re.sub(r"\((?=[^)]*(?:петл|PL\d|AGB|защел|стекл))[^)]*\)", " ", tail, flags=re.I)
    return " ".join(tail.split()) or " ".join((color_text or "").split())


def film_for_color(db: Session, color: str, index=None) -> tuple[str, str] | None:
    """Плёнка для цвета двери — тем же подбором, что при загрузке заданий
    на окутку (services/sku_matching): «Полипропилен Аляска» → (Полипропилен,
    Аляска). ПЭТ 2Д и 3Д одного цвета → материал «ПЭТ» (тип ПЭТ решается у
    детали). Неоднозначно или не найдено — None."""
    from app.services.film_check import pet_of_material
    from app.services.sku_matching import _bare_color, build_sku_match_index, match_sku_by_color_text

    index = index or build_sku_match_index(db)
    sku, cands = match_sku_by_color_text(index, color)
    if sku is not None:
        return sku.material.name, sku.color.name
    skus = [index.sku_by_id[c["sku_id"]] for c in cands if c["sku_id"] in index.sku_by_id]
    # Нечёткий подбор цепляет соседние цвета («Белый» → и «Бежевый»): оставляем
    # те, у кого само название цвета совпадает.
    same = [x for x in skus if _bare_color(x.color.name) == _bare_color(color)] or skus
    if len({x.color_id for x in same}) != 1:
        return None
    mats = {x.material.name for x in same}
    if len(mats) == 1:
        return mats.pop(), same[0].color.name
    if all(pet_of_material(m) is not None for m in mats):
        return "ПЭТ", same[0].color.name
    return None


def _norm_color(v: str) -> str:
    return " ".join(re.sub(r"\(.*?\)", " ", v).lower().replace("ё", "е").split())


def _color_option(db: Session, prop, color: str) -> tuple[object | None, str | None]:
    """Вариант «Цвет» для цвета из графика: подбираем плёнку (как на
    заданиях на окутку) и берём вариант с этой плёнкой; такого нет —
    заводится новый вариант с привязкой к найденной плёнке."""
    from app.models.items import ItemPropertyOption

    opts = [o for o in prop.options if o.is_active]
    opt = next((o for o in opts if _norm_color(o.value) == _norm_color(color)), None)
    if opt is not None and (opt.params or {}).get("цвет_плёнки"):
        return opt, None
    film = film_for_color(db, color)
    if opt is not None:
        # вариант заведён раньше без плёнки — привязываем, если нашлась
        if film is None:
            return opt, f"цвет «{opt.value}» — плёнка не найдена, привяжите в типе"
        opt.params = {**(opt.params or {}), "материал_плёнки": film[0], "цвет_плёнки": film[1]}
        db.flush()
        return opt, f"цвет «{opt.value}» привязан к плёнке {film[0]} {film[1]}"
    if film is not None:
        key = (_norm_color(film[0]), _norm_color(film[1]))
        same = [
            o for o in opts
            if (_norm_color(str((o.params or {}).get("материал_плёнки") or "")), _norm_color(str((o.params or {}).get("цвет_плёнки") or ""))) == key
        ]
        if len(same) == 1:
            return same[0], f"цвет «{color}» → «{same[0].value}» (плёнка {film[0]} {film[1]})"
    params = {"материал_плёнки": film[0], "цвет_плёнки": film[1]} if film else {}
    opt = ItemPropertyOption(property_id=prop.id, value=color, params=params, is_active=True,
                             sort_order=max([o.sort_order or 0 for o in prop.options] or [0]) + 1)
    db.add(opt)
    db.flush()
    db.refresh(prop)
    note = f"новый цвет «{color}»" + (f" — плёнка {film[0]} {film[1]}" if film else " — плёнка не найдена, привяжите в типе")
    return opt, note


def _values_for_row(type_: ItemType, row: ScheduleRow, db: Session | None = None) -> tuple[dict[int, object], list[str]]:
    props = {p.code: p for p in type_.properties}
    missing = [c for c in REQUIRED_CODES if c not in props]
    if missing:
        return {}, [f"У типа «{type_.name}» нет свойств: {', '.join(missing)}"]
    errors: list[str] = []
    by_key = {series_key(o.value): o for o in props["серия"].options if o.is_active}
    series = by_key.get(series_key(row.series_text))
    if series is None:
        errors.append(f"серии «{row.series_text}» нет в списке серий типа")
    size = parse_size(row.size_text)
    if size is None:
        errors.append(f"размер «{row.size_text}» не разобран (ждём «800х2000»)")
    color = color_from_name(row.name_text, row.color_text)
    if not color:
        errors.append("не указан цвет")
    # «Цвет» у типа — список вариантов (цвет привязан к плёнке): «ПЭТ Бежевый»
    # из графика = вариант «ПЭТ Бежевый (cream silk)» — сравниваем без скобок.
    color_value: object = color
    if color and props["цвет"].value_type == "list":
        opts = [o for o in props["цвет"].options if o.is_active]
        opt = next((o for o in opts if _norm_color(o.value) == _norm_color(color)), None) or next(
            (o for o in opts if _norm_color(o.value) == _norm_color(row.color_text or "")), None
        )
        if db is not None and (opt is None or not (opt.params or {}).get("цвет_плёнки")):
            opt, note = _color_option(db, props["цвет"], opt.value if opt is not None else color)
            if note:
                _ROW_NOTES.append(note)
        if opt is None:
            errors.append(f"цвета «{color}» нет в вариантах свойства «Цвет» — добавьте его в типе")
        else:
            color_value = opt.id
    if errors:
        return {}, errors
    features = parse_line_features(row.name_text, (series.params or {}).get("кромка") or "abs")
    edge = next((o for o in props["кромка"].options if o.value == features.edge_type), None)
    if edge is None:
        return {}, [f"кромки «{features.edge_type}» нет в вариантах свойства «Кромка»"]
    return {
        props["серия"].id: series.id,
        props["ширина"].id: float(size[0]),
        props["высота"].id: float(size[1]),
        props["цвет"].id: color_value,
        props["стекло"].id: features.glass,  # вид стекла, "" — без стекла
        props["молдинг"].id: features.has_moulding,
        props["замок"].id: features.needs_lock_milling,
        props["кромка"].id: edge.id,
        props["цвет_кромки"].id: features.edge_text,
    }, []


def import_schedule(
    db: Session, *, text: str, type_: ItemType, order_name: str | None, user_id: int, dry_run: bool
) -> tuple[list[ImportRow], list[str], ProductionOrder | None]:
    """dry_run — только предпросмотр. Иначе — позиции по типу и черновик
    заказа; если хоть одна строка с ошибкой — ничего не создаётся."""
    rows, parse_errors = parse_pasted_schedule(text)
    out: list[ImportRow] = []
    values_by_row: list[dict[int, object]] = []
    for r in rows:
        ir = ImportRow(
            series=r.series_text, size=r.size_text, color=r.color_text, name_text=r.name_text, qty=r.doors_qty,
            invoice_no=r.invoice_no, ship_date=r.ship_date.isoformat() if r.ship_date else None,
        )
        _ROW_NOTES.clear()
        values, errors = _values_for_row(type_, r, db)
        ir.errors.extend(errors)
        ir.notes.extend(_ROW_NOTES)
        if not errors:
            res = type_rules.compute(db, type_, type_rules.context_from_values(db, type_, values))
            ir.errors.extend(res.errors)
            ir.item_name = res.name
            if res.name:
                existing = db.query(Item).filter(Item.kind_id == type_.kind_id, func.lower(Item.name) == res.name.lower()).first()
                ir.exists = existing is not None
                ir.item_id = existing.id if existing else None
        out.append(ir)
        values_by_row.append(values)
    if dry_run or not rows or parse_errors or any(r.errors for r in out):
        return out, parse_errors, None

    ship_dates = [r.ship_date for r in rows if r.ship_date]
    name = (order_name or "").strip()
    if not name:
        name = f"График, отгрузка с {min(ship_dates).strftime('%d.%m.%Y')}" if ship_dates else "График"
    order = ProductionOrder(
        name=name, ship_date=min(ship_dates) if ship_dates else None, status=ORDER_DRAFT, created_by=user_id,
    )
    db.add(order)
    db.flush()
    for i, (ir, values, r) in enumerate(zip(out, values_by_row, rows), start=1):
        item, created, errors = type_rules.ensure_item(db, type_, values)
        if errors:
            ir.errors.extend(errors)
            return out, parse_errors, None
        ir.item_id, ir.item_name, ir.exists = item.id, item.name, not created
        note = "; ".join(x for x in (f"счёт {r.invoice_no}" if r.invoice_no else "", r.ship_date.strftime("%d.%m") if r.ship_date else "") if x)
        order.lines.append(ProductionOrderLine(item_id=item.id, quantity=r.doors_qty, note=note or None, sort_order=i))
    db.flush()
    return out, parse_errors, order
