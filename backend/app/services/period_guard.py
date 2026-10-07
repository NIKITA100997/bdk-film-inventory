"""Закрытый период (07.10.2026): записи с датой не позже границы закрытия не
создаются, не правятся и не удаляются — проверка одна на всё приложение,
перед записью в базу (before_flush), чтобы её не обошёл ни один экран.

Граница — последняя запись period_closings. Обойти можно только
подтверждённым запросом администратору: при его выполнении сессия несёт
session.info["period_override"] (ставит get_current_user по токену запроса).
"""

import time
from datetime import date, datetime

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from app.models.control import PeriodClosing
from app.models.events import MaterialEvent
from app.models.finished_goods import FgMove
from app.models.part_units import PartUnitEvent
from app.models.prices import ItemPrice
from app.models.production import ProductionTaskLineReport
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Moscow")

# что охраняем: класс → поле даты
GUARDED = {
    MaterialEvent: "timestamp",
    PartUnitEvent: "occurred_at",
    FgMove: "occurred_at",
    ProductionTaskLineReport: "reported_at",
    ItemPrice: "valid_from",
}
LABEL = {
    MaterialEvent: "движение рулона",
    PartUnitEvent: "движение партии п/ф",
    FgMove: "движение готовой продукции",
    ProductionTaskLineReport: "отчёт о производстве",
    ItemPrice: "цена",
}

_cache: dict = {"at": 0.0, "value": None}
TTL = 10.0


class PeriodClosedError(Exception):
    def __init__(self, what: str, day: date, until: date):
        self.until = until
        super().__init__(
            f"Период по {until:%d.%m.%Y} закрыт — {what} за {day:%d.%m.%Y} записать или изменить нельзя. "
            "Попросите администратора или откройте период."
        )


def invalidate() -> None:
    _cache["at"] = 0.0


def closed_until(db: Session) -> date | None:
    now = time.monotonic()
    if now - _cache["at"] < TTL:
        return _cache["value"]
    row = db.query(PeriodClosing).order_by(PeriodClosing.id.desc()).first()
    _cache["value"] = row.closed_until if row else None
    _cache["at"] = now
    return _cache["value"]


def _as_date(v) -> date | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        if v.tzinfo is not None:
            v = v.astimezone(TZ)
        return v.date()
    if isinstance(v, date):
        return v
    return None


def _old_value(obj, field: str):
    hist = inspect(obj).attrs[field].history
    if hist.deleted:
        return hist.deleted[0]
    if hist.unchanged:
        return hist.unchanged[0]
    return getattr(obj, field, None)


@event.listens_for(Session, "before_flush")
def _guard(session: Session, flush_context, instances) -> None:
    if session.info.get("period_override"):
        return
    touched = [o for o in (*session.new, *session.dirty, *session.deleted) if type(o) in GUARDED]
    if not touched:
        return
    with session.no_autoflush:
        until = closed_until(session)
    if until is None:
        return
    for obj in touched:
        cls = type(obj)
        field = GUARDED[cls]
        days = []
        if obj in session.new:
            days.append(_as_date(getattr(obj, field, None)))
        else:
            if obj in session.dirty and not session.is_modified(obj, include_collections=False):
                continue
            days.append(_as_date(_old_value(obj, field)))
            if obj in session.dirty:
                days.append(_as_date(getattr(obj, field, None)))
        for d in days:
            if d is not None and d <= until:
                raise PeriodClosedError(LABEL[cls], d, until)
