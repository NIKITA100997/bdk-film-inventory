"""Контроль заказов (12.10, этап 4): отставания, уменьшение строки,
отмена, отчёт по срокам."""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.production_orders import ORDER_RELEASED, ProductionOrder, ProductionOrderLine
from app.models.users import User
from app.services import bitrix
from app.services import order_control as oc
from app.services.planning import schedule_order
from app.services.production_orders import OrderError, close_order

router = APIRouter(tags=["order-control"])
view = require_permission("production_tasks.manage", "production_tasks.view", "orders.request", "sales_calculator.view", "plan.approve")
manage = require_permission("production_tasks.manage")


class LagOut(BaseModel):
    order_id: int
    name: str
    customer: str | None
    manager: str | None
    overdue: float
    plan_finish: date | None
    promised_ready: date | None
    late: bool


@router.get("/order-control/lagging", response_model=list[LagOut])
def list_lagging(db: Session = Depends(get_db), user: User = Depends(view)) -> list[LagOut]:
    names = {u.id: (u.full_name or u.username) for u in db.query(User)}
    return [
        LagOut(manager=", ".join(filter(None, (names.get(u) for u in x.manager_ids))) or None,
               **{k: v for k, v in x.__dict__.items() if k not in ("manager_id", "manager_ids")})
        for x in oc.lagging(db)
    ]


@router.post("/order-control/lag-digest")
def send_lag_digest(db: Session = Depends(get_db), user: User = Depends(manage)) -> dict:
    """Отправить сводку отставаний в Битрикс24 сейчас (обычно — сама, утром)."""
    from app.models.integrations import AppSetting

    mark = db.get(AppSetting, "lag_digest")
    if mark is not None:
        mark.value = None
        db.flush()
    return {"orders": oc.lag_digest(db)}


class ReduceIn(BaseModel):
    quantity: float = Field(gt=0)
    reason: str | None = Field(default=None, max_length=255)
    apply: bool = False


class ReduceRowOut(BaseModel):
    task_line_id: int
    area: str
    what: str
    old: float
    new: float
    done: float
    surplus: float


class ReduceOut(BaseModel):
    rows: list[ReduceRowOut]
    merged: list[str]
    applied: bool


@router.post("/production-orders/{order_id}/lines/{line_id}/reduce", response_model=ReduceOut)
def reduce_order_line(order_id: int, line_id: int, payload: ReduceIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> ReduceOut:
    """Клиент уменьшил количество в запущенном заказе: без apply —
    предпросмотр по этапам, с apply — уменьшить несделанное и пересчитать
    сроки."""
    order = db.get(ProductionOrder, order_id)
    ol = db.get(ProductionOrderLine, line_id)
    if order is None or ol is None or ol.order_id != order.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Строка заказа не найдена")
    if order.status != ORDER_RELEASED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Черновик правится через «Изменить строки»; закрытый — не правится")
    if payload.quantity >= float(ol.quantity):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Новое количество должно быть меньше текущего — увеличение оформляется новой заявкой")
    if payload.apply and not (payload.reason or "").strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите причину уменьшения")
    old = float(ol.quantity)
    plan = oc.reduce_line(db, order, ol, payload.quantity, payload.apply)
    if payload.apply:
        from app.services.weekly_plan import note_change, order_day

        schedule_order(db, order, user.id)
        d = order_day(order)
        note_change(db, order, d, d, f"уменьшено {old:g} → {payload.quantity:g} шт ({payload.reason})", user.id)
        for uid in oc.managers_of(db, order):
            bitrix.message_to_user(db, "order_reduced", uid,
                                   f"Уменьшен заказ: {bitrix.order_title(db, order)}\nСтрока: {old:g} → {payload.quantity:g} шт. Причина: {payload.reason}")
        db.commit()
    else:
        db.rollback()
    return ReduceOut(rows=[ReduceRowOut(**r.__dict__) for r in plan.rows], merged=plan.merged, applied=payload.apply)


class CancelIn(BaseModel):
    reason: str = Field(min_length=2, max_length=255)


@router.post("/production-orders/{order_id}/cancel")
def cancel_order(order_id: int, payload: CancelIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> dict:
    """Отмена запущенного заказа с причиной: задания в архив; сделанные п/ф
    остаются в остатке участков под другие заказы."""
    order = db.get(ProductionOrder, order_id)
    if order is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заказ не найден")
    try:
        close_order(db, order)
    except OrderError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    order.note = (f"Отменён: {payload.reason}. " + (order.note or ""))[:500]
    from app.services.weekly_plan import note_change, order_day

    d = order_day(order)
    note_change(db, order, d, None, f"отменён ({payload.reason})", user.id)
    for uid in oc.managers_of(db, order):
        bitrix.message_to_user(db, "order_cancelled", uid, f"Отменён заказ: {bitrix.order_title(db, order)}\nПричина: {payload.reason}")
    db.commit()
    return {"ok": True}


class DeadlineOut(BaseModel):
    order_id: int
    name: str
    customer: str | None
    manager: str | None
    status: str
    promised_ready: date | None
    ready_fact: date | None
    ready_on_time: bool | None
    ship_date: date | None
    shipped_at: date | None
    shipped_all: bool
    ship_on_time: bool | None
    moves: int


class DeadlinesOut(BaseModel):
    rows: list[DeadlineOut]
    by_manager: dict[str, dict]
    reasons: list[tuple[str, int]]


@router.get("/order-control/deadlines", response_model=DeadlinesOut)
def deadlines_report(date_from: date = Query(...), date_to: date = Query(...), db: Session = Depends(get_db), user: User = Depends(view)) -> DeadlinesOut:
    rows, by_manager, reasons = oc.deadlines(db, date_from, date_to)
    return DeadlinesOut(rows=[DeadlineOut(**r.__dict__) for r in rows], by_manager=by_manager, reasons=reasons)
