"""Импорт графика запуска щитовых дверей в заказ на производство (единая
модель). Разбор строк — services/shield_schedule.py; здесь строка графика
становится значениями свойств типа «Щитовая дверь» (по кодам свойств:
серия, ширина, высота, цвет, стекло, молдинг, замок, кромка), позиция
находится или создаётся по типу, строка — строкой заказа."""

from dataclasses import dataclass, field

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.items import Item, ItemType
from app.models.production_orders import ORDER_DRAFT, ProductionOrder, ProductionOrderLine
from app.services import type_rules
from app.services.shield_schedule import ScheduleRow, parse_line_features, parse_pasted_schedule, parse_size, series_key

REQUIRED_CODES = ("серия", "ширина", "высота", "цвет", "стекло", "молдинг", "замок", "кромка")


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


def _values_for_row(type_: ItemType, row: ScheduleRow) -> tuple[dict[int, object], list[str]]:
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
    color = " ".join((row.color_text or "").split())
    if not color:
        errors.append("не указан цвет")
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
        props["цвет"].id: color,
        props["стекло"].id: features.has_glass,
        props["молдинг"].id: features.has_moulding,
        props["замок"].id: features.needs_lock_milling,
        props["кромка"].id: edge.id,
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
        values, errors = _values_for_row(type_, r)
        ir.errors.extend(errors)
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
