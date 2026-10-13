"""Потребность по заказам (12.10, этап 2): что нужно каждому открытому
заказу, что дефицит и к какому дню; заявка на закупку одной кнопкой —
плёнка в «Заявки на закупку» (с «нужно к»), материалы — задачей закупщику
в Битрикс24."""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.items import Item
from app.models.purchasing import PurchaseRequest
from app.models.users import User
from app.services import bitrix
from app.services.order_needs import _film_label as bitrix_film_name, compute, summary

router = APIRouter(prefix="/needs", tags=["needs"])
view = require_permission("production_tasks.manage", "production_tasks.view", "purchasing.manage", "orders.request", "sales_calculator.view")
order_purchase = require_permission("production_tasks.manage", "purchasing.manage")


class NeedRowOut(BaseModel):
    kind: str
    key: str
    name: str
    unit: str
    need: float
    allocated: float
    shortage: float
    need_by: date | None
    incoming: float
    incoming_date: date | None


class FgFreeOut(BaseModel):
    item_id: int
    name: str
    need: float
    free: float


class OrderNeedsOut(BaseModel):
    order_id: int
    name: str
    group: str
    priority: int
    date: date | None
    rows: list[NeedRowOut]
    fg: list[FgFreeOut]
    error: str | None = None
    customer_order_id: int | None = None  # строка — заказ клиента (order_id = его id)


def _rows(on) -> OrderNeedsOut:
    return OrderNeedsOut(
        order_id=on.order_id, name=on.name, group=on.group, priority=on.priority, date=on.date, error=on.error,
        customer_order_id=on.customer_order_id,
        rows=[NeedRowOut(**r.__dict__) for r in on.rows], fg=[FgFreeOut(**f.__dict__) for f in on.fg],
    )


@router.get("/orders/{order_id}", response_model=OrderNeedsOut | None)
def order_needs(order_id: int, db: Session = Depends(get_db), user: User = Depends(view)) -> OrderNeedsOut | None:
    """Потребность заказа с учётом очереди: склад сначала отдан заказам впереди."""
    try:
        for on in compute(db, user.id):
            if on.order_id == order_id and on.customer_order_id is None:
                return _rows(on)
        return None
    finally:
        db.rollback()


@router.get("/customer-orders/{order_id}", response_model=OrderNeedsOut | None)
def customer_order_needs(order_id: int, db: Session = Depends(get_db), user: User = Depends(view)) -> OrderNeedsOut | None:
    """Потребность незапущенного остатка заказа клиента — с учётом очереди."""
    try:
        for on in compute(db, user.id):
            if on.customer_order_id == order_id:
                return _rows(on)
        return None
    finally:
        db.rollback()


class SummaryOut(BaseModel):
    kind: str
    key: str
    name: str
    unit: str
    shortage: float
    need_by: date | None
    orders: list[dict]


class NeedsOverviewOut(BaseModel):
    shortages: list[SummaryOut]
    orders: list[OrderNeedsOut]


@router.get("", response_model=NeedsOverviewOut)
def needs_overview(db: Session = Depends(get_db), user: User = Depends(view)) -> NeedsOverviewOut:
    try:
        res = compute(db, user.id)
        return NeedsOverviewOut(shortages=[SummaryOut(**s.__dict__) for s in summary(res)], orders=[_rows(on) for on in res])
    finally:
        db.rollback()


class PurchaseItemIn(BaseModel):
    key: str
    qty: float = Field(gt=0)
    need_by: date | None = None
    order_ids: list[int] = []
    labels: list[str] = []  # подписи заказов для заметки (заказы клиентов — по счёту)


class PurchaseIn(BaseModel):
    items: list[PurchaseItemIn]
    comment: str | None = Field(default=None, max_length=255)


class PurchaseOut(BaseModel):
    film_requests: list[int]
    bitrix_tasks: int
    not_sent: list[str]


@router.post("/purchase", response_model=PurchaseOut)
def purchase_shortages(payload: PurchaseIn, db: Session = Depends(get_db), user: User = Depends(order_purchase)) -> PurchaseOut:
    """Дефицит → закупка: плёнка — заявка на закупку (м², «нужно к», под
    какие заказы), материал — задача закупщику в Битрикс24 и сообщение в
    чат закупок."""
    film_ids: list[int] = []
    tasks = 0
    not_sent: list[str] = []
    s = bitrix.get_settings(db)
    film_lines: list[str] = []
    for it in payload.items:
        orders = ", ".join(it.labels or [f"№{i}" for i in it.order_ids])
        by = f" к {it.need_by:%d.%m}" if it.need_by else ""
        note = f"Дефицит под заказы {orders}{by}" + (f". {payload.comment}" if payload.comment else "")
        if it.key.startswith("film:"):
            m, c, t = (int(x) for x in it.key.split(":")[1].split("-"))
            pr = PurchaseRequest(
                material_id=m, color_id=c, thickness_id=t, requested_area_m2=round(it.qty, 2), note=note[:255],
                created_by=user.id, origin="needs", need_by=it.need_by,
            )
            db.add(pr)
            db.flush()
            film_ids.append(pr.id)
            film_lines.append(f"{bitrix_film_name(db, m, c, t)} — {it.qty:g} м²{by} (заказы {orders})")
        elif it.key.startswith("item:"):
            item = db.get(Item, int(it.key.split(":")[1]))
            if item is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Материал не найден")
            unit = item.unit or (item.kind.unit if item.kind else "")
            title = f"Закупить: {item.name} — {it.qty:g} {unit}{by}"
            if s.get("enabled") and s.get("webhook") and (s.get("purchaser") or s.get("chat_purchasing")):
                bitrix.task_for_purchase(db, title, note, it.need_by)
                tasks += 1
            else:
                not_sent.append(title)
    if film_lines:
        text = "Заявки на закупку плёнки (дефицит по заказам):\n" + "\n".join(film_lines)
        bitrix.message_to_chat(db, "purchase_task", "chat_purchasing", text)
    db.commit()
    return PurchaseOut(film_requests=film_ids, bitrix_tasks=tasks, not_sent=not_sent)
