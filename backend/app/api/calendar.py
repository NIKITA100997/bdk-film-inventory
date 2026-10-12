"""Производственный календарь (12.10): пятидневка с праздниками РФ и
исключениями — рабочая суббота, нерабочий день (отключили свет); для всех
участков или для одного. Сроки операций считаются по нему
(services/planning.is_workday)."""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.production_orders import ORDER_RELEASED, ProductionCalendarDay, ProductionOrder
from app.models.users import User
from app.services.planning import invalidate_calendar, load_calendar, schedule_order

router = APIRouter(prefix="/production-calendar", tags=["calendar"])
manage = require_permission("production_tasks.manage")


class CalendarDayOut(BaseModel):
    id: int
    day: date
    area: str | None
    area_name: str | None
    is_workday: bool
    note: str | None


class CalendarDayIn(BaseModel):
    day: date
    area: str | None = None
    is_workday: bool
    note: str | None = Field(default=None, max_length=255)


def _out(db: Session, c: ProductionCalendarDay) -> CalendarDayOut:
    a = db.get(Area, c.area) if c.area else None
    return CalendarDayOut(id=c.id, day=c.day, area=c.area, area_name=a.name if a else None, is_workday=c.is_workday, note=c.note)


@router.get("", response_model=list[CalendarDayOut])
def list_days(
    date_from: date = Query(...), date_to: date = Query(...), db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> list[CalendarDayOut]:
    rows = (
        db.query(ProductionCalendarDay)
        .filter(ProductionCalendarDay.day >= date_from, ProductionCalendarDay.day <= date_to)
        .order_by(ProductionCalendarDay.day, ProductionCalendarDay.area.nullsfirst())
        .all()
    )
    return [_out(db, c) for c in rows]


@router.put("", response_model=CalendarDayOut | None)
def set_day(payload: CalendarDayIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> CalendarDayOut | None:
    """Поставить исключение на день. Совпало с обычным (будни — рабочий,
    выходные — нет) для всех участков и без пометки — исключение снимается."""
    if payload.area is not None and db.get(Area, payload.area) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Участок не найден")
    q = db.query(ProductionCalendarDay).filter(ProductionCalendarDay.day == payload.day)
    q = q.filter(ProductionCalendarDay.area == payload.area) if payload.area else q.filter(ProductionCalendarDay.area.is_(None))
    row = q.first()
    plain = payload.area is None and payload.is_workday == (payload.day.weekday() < 5) and not (payload.note or "").strip()
    if plain:
        if row is not None:
            db.delete(row)
        db.commit()
        invalidate_calendar()
        return None
    if row is None:
        row = ProductionCalendarDay(day=payload.day, area=payload.area, created_by=user.id)
        db.add(row)
    row.is_workday = payload.is_workday
    row.note = (payload.note or "").strip() or None
    db.commit()
    invalidate_calendar()
    return _out(db, row)


@router.delete("/{day_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_day(day_id: int, db: Session = Depends(get_db), user: User = Depends(manage)) -> None:
    row = db.get(ProductionCalendarDay, day_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Нет такого исключения")
    db.delete(row)
    db.commit()
    invalidate_calendar()


@router.post("/reschedule")
def reschedule_open_orders(db: Session = Depends(get_db), user: User = Depends(manage)) -> dict:
    """После правки календаря: пересчитать сроки запущенных заказов —
    автоматические дни плана заново, ручные — как есть."""
    load_calendar(db, force=True)
    n = late = 0
    for order in db.query(ProductionOrder).filter(ProductionOrder.status == ORDER_RELEASED):
        r = schedule_order(db, order, user.id)
        n += 1
        late += int(r.late)
    db.commit()
    return {"orders": n, "late": late}
