"""Средний расход п/ф и мин. остаток от него (14.10).

Расход детали — всё, что ушло с остатка списанием за период: «Списано по
заданию» (взяли в работу) плюс брак и пусковые — физически деталь тоже
израсходована. Корректировки не входят. Средний расход — на рабочий день
по общему календарю производства (выходные и праздники не считаются).

Мин. остаток = средний расход в день × дни запаса. Дни запаса задаются
вручную у позиции (Item.reserve_days); пересчёт мин. остатка — кнопкой,
не сам: расход за неделю может прыгнуть, норматив не должен."""

import math
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.dictionaries import Part
from app.models.items import Item
from app.models.part_units import PartEventType, PartUnit, PartUnitEvent

CONSUMED_REASON = "spisano_po_zadaniyu"


@dataclass
class ConsumptionRow:
    item_id: int
    part_id: int
    name: str
    consumed: float  # за период, шт
    to_work: float  # из них «Списано по заданию»
    per_week: float
    per_day: float
    reserve_days: float | None
    min_stock: float | None
    suggested_min: float | None


def workdays(start: date, end: date) -> int:
    """Рабочих дней в [start, end) по календарю производства."""
    from app.services.planning import is_workday

    return sum(1 for i in range((end - start).days) if is_workday(start + timedelta(days=i)))


def suggest_min(per_day: float, reserve_days: float | None) -> float | None:
    if reserve_days is None or per_day <= 0:
        return None
    return float(math.ceil(per_day * float(reserve_days)))


def pf_consumption(db: Session, weeks: int, today: date | None = None) -> tuple[list[ConsumptionRow], int, date, date]:
    from app.services.planning import load_calendar

    load_calendar(db)
    end = today or date.today()
    start = end - timedelta(days=weeks * 7)
    days = max(1, workdays(start, end))
    since, until = datetime.combine(start, time.min).astimezone(), datetime.combine(end, time.min).astimezone()
    totals: dict[int, list[float]] = {}
    rows = (
        db.query(PartUnit.part_id, PartUnitEvent.write_off_reason, func.sum(-PartUnitEvent.quantity_delta))
        .join(PartUnit, PartUnit.id == PartUnitEvent.part_unit_id)
        .filter(
            PartUnitEvent.event_type == PartEventType.SPISANIE,
            PartUnitEvent.occurred_at >= since,
            PartUnitEvent.occurred_at < until,
        )
        .group_by(PartUnit.part_id, PartUnitEvent.write_off_reason)
    )
    for part_id, reason, qty in rows:
        t = totals.setdefault(part_id, [0.0, 0.0])
        t[0] += float(qty or 0)
        if reason == CONSUMED_REASON:
            t[1] += float(qty or 0)
    out: list[ConsumptionRow] = []
    for part, item in db.query(Part, Item).join(Item, Item.id == Part.item_id):
        consumed, to_work = totals.get(part.id, [0.0, 0.0])
        reserve = float(item.reserve_days) if item.reserve_days is not None else None
        if consumed <= 0 and reserve is None and item.min_stock is None:
            continue
        per_day = consumed / days
        out.append(ConsumptionRow(
            item_id=item.id, part_id=part.id, name=part.name, consumed=round(consumed, 2), to_work=round(to_work, 2),
            per_week=round(consumed / weeks, 1), per_day=round(per_day, 2), reserve_days=reserve,
            min_stock=float(item.min_stock) if item.min_stock is not None else None, suggested_min=suggest_min(per_day, reserve),
        ))
    out.sort(key=lambda r: (-r.consumed, r.name))
    return out, days, start, end


def apply_min_stock(db: Session, item: Item, value: float | None) -> None:
    """Мин. остаток позиции и (у п/ф) детали — как «Нормативы»."""
    item.min_stock = value
    part = db.query(Part).filter(Part.item_id == item.id).first()
    if part is not None:
        part.min_stock_pieces = value
