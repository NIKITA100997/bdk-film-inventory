"""Заказы клиентов (13.10): заказ = один счёт 1С. Менеджер заводит
(вручную или из счёта/графика), ставит вилку отгрузки и приоритет,
проверяет срок, отправляет; производство принимает с обещанными
готовностью и отгрузкой или возвращает; переносы — с причиной; принятые
заказы начальник производства собирает в заказ на производство."""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import get_permission_codes, require_permission
from app.db.session import get_db
from app.models.customer_orders import (
    CO_ACCEPTED,
    CO_CANCELLED,
    CO_DRAFT,
    CO_RETURNED,
    CO_SUBMITTED,
    CustomerOrder,
    CustomerOrderLine,
)
from app.models.items import Item, ItemType
from app.models.production_orders import OrderDateChange
from app.models.users import User
from app.services import bitrix
from app.services import bitrix_deals as deals
from app.services import customer_orders as cos
from app.services.components import live_item_names

router = APIRouter(prefix="/customer-orders", tags=["customer-orders"])
view = require_permission("production_tasks.manage", "production_tasks.view", "production_tasks.report", "orders.request", "sales_calculator.view", "plan.approve")
edit = require_permission("production_tasks.manage", "orders.request")
manage = require_permission("production_tasks.manage")

REASONS = {
    "material": "Нет материала", "capacity": "Перегруз участка", "client": "Просьба клиента", "defect": "Брак, переделка",
    "equipment": "Поломка оборудования", "calendar": "Нерабочий день", "urgent": "Вставили срочный заказ", "other": "Другое",
}


def _is_production(user: User) -> bool:
    return user.is_superuser or "production_tasks.manage" in get_permission_codes(user)


def _name(db: Session, uid: int | None) -> str | None:
    u = db.get(User, uid) if uid else None
    return (u.full_name or u.username) if u else None


class LineIn(BaseModel):
    item_id: int
    quantity: float = Field(gt=0)
    note: str | None = Field(default=None, max_length=255)  # длиннее — была ошибка 500 (14.10)


class OrderIn(BaseModel):
    invoice_no: str = Field(min_length=1, max_length=64)
    invoice_date: date | None = None
    customer: str | None = Field(default=None, max_length=255)
    amount_rub: float | None = Field(default=None, ge=0)
    priority: int = Field(default=0, ge=0, le=2)
    ship_from: date | None = None
    ship_to: date | None = None
    note: str | None = Field(default=None, max_length=500)
    manager_id: int | None = None
    lines: list[LineIn] = Field(min_length=1)


class LineOut(BaseModel):
    id: int
    item_id: int
    item_name: str
    quantity: float
    launched: float
    note: str | None


class ChangeOut(BaseModel):
    field: str
    old_date: date | None
    new_date: date | None
    reason_name: str | None
    comment: str | None
    user_name: str | None
    created_at: datetime


class OrderOut(BaseModel):
    id: int
    invoice_no: str
    invoice_date: date | None
    customer: str | None
    manager_id: int | None
    manager_name: str | None
    amount_rub: float | None
    priority: int
    ship_from: date | None
    ship_to: date | None
    promised_ready: date | None
    ship_date: date | None
    status: str
    stage: str
    stage_label: str
    request_comment: str | None
    submitted_at: datetime | None
    decided_by_name: str | None
    note: str | None
    created_at: datetime
    qty: float
    launched: float
    in_work: float
    received: float
    shipped: float
    ready_fact: date | None
    last_shipped_at: date | None
    plan_finish: date | None = None
    plan_late: bool = False
    production_orders: list[dict]
    lines: list[LineOut]
    date_changes: list[ChangeOut] = []
    bitrix_deal_id: int | None = None
    bitrix_deal_url: str | None = None
    bitrix_deals_on: bool = False  # сделки Битрикс24 включены в настройках


def _out(db: Session, co: CustomerOrder, full: bool = True) -> OrderOut:
    from app.models.production_orders import ProductionOrder
    from app.services.planning import order_plan_status

    p = cos.progress(db, co)
    names = live_item_names(db, {ln.item_id for ln in co.lines})
    finish, late = None, False
    for po_id, _n, st in p.production_orders:
        if st == "released":
            ps = order_plan_status(db, db.get(ProductionOrder, po_id))
            if ps.finish and (finish is None or ps.finish > finish):
                finish = ps.finish
    if finish and co.promised_ready:
        late = finish > co.promised_ready
    changes = []
    if full:
        changes = [
            ChangeOut(field=c.field, old_date=c.old_date, new_date=c.new_date, reason_name=REASONS.get(c.reason or ""),
                      comment=c.comment, user_name=_name(db, c.user_id), created_at=c.created_at)
            for c in db.query(OrderDateChange).filter(OrderDateChange.customer_order_id == co.id).order_by(OrderDateChange.created_at.desc(), OrderDateChange.id.desc())
        ]
    return OrderOut(
        id=co.id, invoice_no=co.invoice_no, invoice_date=co.invoice_date, customer=co.customer, manager_id=co.manager_id,
        manager_name=_name(db, co.manager_id or co.created_by),
        amount_rub=float(co.amount_rub) if co.amount_rub is not None else None, priority=co.priority or 0,
        ship_from=co.ship_from, ship_to=co.ship_to, promised_ready=co.promised_ready, ship_date=co.ship_date,
        status=co.status, stage=p.stage, stage_label=cos.STAGE_LABEL.get(p.stage, p.stage),
        request_comment=co.request_comment, submitted_at=co.submitted_at, decided_by_name=_name(db, co.decided_by),
        note=co.note, created_at=co.created_at, qty=p.qty, launched=round(p.launched, 2), in_work=round(p.in_work, 2),
        received=p.received, shipped=p.shipped, ready_fact=p.ready_fact, last_shipped_at=p.last_shipped_at,
        plan_finish=finish, plan_late=late,
        production_orders=[{"id": i, "name": n, "status": st} for i, n, st in p.production_orders],
        lines=[LineOut(id=ln.id, item_id=ln.item_id, item_name=names.get(ln.item_id, "?"), quantity=float(ln.quantity),
                       launched=round(p.line_launched.get(ln.id, 0.0), 2), note=ln.note) for ln in co.lines],
        date_changes=changes,
        bitrix_deal_id=co.bitrix_deal_id,
        bitrix_deal_url=deals.deal_url(bitrix.get_settings(db), co.bitrix_deal_id) if co.bitrix_deal_id else None,
        bitrix_deals_on=full and deals.enabled(bitrix.get_settings(db)),
    )


def _get(db: Session, oid: int) -> CustomerOrder:
    co = db.get(CustomerOrder, oid)
    if co is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заказ клиента не найден")
    return co


def _check_editable(co: CustomerOrder, user: User) -> None:
    if _is_production(user):
        if co.status == CO_CANCELLED:
            raise HTTPException(status.HTTP_409_CONFLICT, "Заказ отменён")
        return
    if co.status not in (CO_DRAFT, CO_RETURNED):
        raise HTTPException(status.HTTP_409_CONFLICT, "Заказ уже у производства — изменить его может начальник производства")


@router.get("", response_model=list[OrderOut])
def list_orders(include_closed: bool = Query(default=False), db: Session = Depends(get_db), user: User = Depends(view)) -> list[OrderOut]:
    out = [_out(db, co, full=False) for co in db.query(CustomerOrder).order_by(CustomerOrder.id.desc())]
    if not include_closed:
        out = [o for o in out if o.stage not in ("shipped", "cancelled")]
    return out


class CalendarAreaOut(BaseModel):
    area: str
    area_name: str
    need: float
    done: float
    overdue: float = 0.0
    days: dict[str, list[float]]  # дата → [план, факт]


class CalendarRowOut(BaseModel):
    key: str
    kind: str  # co — заказ клиента, po — заказ на производство без заказов клиентов
    id: int
    title: str
    customer: str | None
    status: str
    ship_date: date | None
    promised_ready: date | None
    plan_finish: date | None
    released: bool
    areas: list[CalendarAreaOut]
    items: list[list] = []
    note: str | None = None
    last_fact: date | None = None
    overdue: float = 0.0


class CalendarTotalOut(BaseModel):
    area: str
    area_name: str
    days: dict[str, list[float]]


@router.get("/calendar/totals", response_model=list[CalendarTotalOut])
def order_calendar_totals(
    date_from: date, date_to: date, db: Session = Depends(get_db), user: User = Depends(view)
) -> list[CalendarTotalOut]:
    """Произведено за день по участкам и план дня — по всем заданиям цеха."""
    from dataclasses import asdict

    from app.services.order_calendar import daily_totals

    if (date_to - date_from).days > 120:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Период — не больше 120 дней")
    return [CalendarTotalOut(**asdict(t)) for t in daily_totals(db, date_from, date_to)]


@router.get("/calendar", response_model=list[CalendarRowOut])
def order_calendar(
    date_from: date, date_to: date, db: Session = Depends(get_db), user: User = Depends(view)
) -> list[CalendarRowOut]:
    """Календарь (14.10): по заказу и участку — план по дням, факт по концу
    дня и «сделано из нужного» (services/order_calendar.py)."""
    from dataclasses import asdict

    from app.services.order_calendar import calendar

    if (date_to - date_from).days > 120:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Период — не больше 120 дней")
    return [CalendarRowOut(**asdict(r)) for r in calendar(db, date_from, date_to)]


@router.get("/{order_id}", response_model=OrderOut)
def get_order(order_id: int, db: Session = Depends(get_db), user: User = Depends(view)) -> OrderOut:
    return _out(db, _get(db, order_id))


def _write(db: Session, co: CustomerOrder, payload: OrderIn) -> None:
    inv = payload.invoice_no.strip()
    dup = db.query(CustomerOrder.id).filter(CustomerOrder.invoice_no == inv, CustomerOrder.id != (co.id or 0)).first()
    if dup:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Заказ по счёту {inv} уже есть — №{dup[0]}")
    if payload.ship_from and payload.ship_to and payload.ship_from > payload.ship_to:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Вилка отгрузки: «с» позже, чем «по»")
    for ln in payload.lines:
        it = db.get(Item, ln.item_id)
        if it is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
        if it.is_model:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"«{it.name}» — модель: в заказ берётся её вариант")
    co.invoice_no, co.invoice_date = inv, payload.invoice_date
    co.customer = (payload.customer or "").strip() or None
    co.amount_rub, co.priority = payload.amount_rub, payload.priority
    co.ship_from, co.ship_to = payload.ship_from, payload.ship_to
    co.note = (payload.note or "").strip() or None
    if payload.manager_id:
        co.manager_id = payload.manager_id
    # строки: запущенные не трогаем — правится количество, новые добавляются
    launched = cos.progress(db, co).line_launched if co.id else {}
    keep = {ln.id: ln for ln in co.lines}
    if not launched:
        co.lines.clear()
    if launched:
        by_item = {ln.item_id: ln for ln in keep.values()}
        for i, ln in enumerate(payload.lines, start=1):
            ex = by_item.pop(ln.item_id, None)
            if ex is not None:
                if ln.quantity < launched.get(ex.id, 0.0):
                    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Нельзя уменьшить ниже запущенного — уменьшайте в заказе на производство")
                ex.quantity, ex.note, ex.sort_order = ln.quantity, (ln.note or "").strip() or None, i
            else:
                co.lines.append(CustomerOrderLine(item_id=ln.item_id, quantity=ln.quantity, note=(ln.note or "").strip() or None, sort_order=i))
        for ex in by_item.values():
            if launched.get(ex.id):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Запущенную позицию нельзя убрать — отмените её в заказе на производство")
            co.lines.remove(ex)
    else:
        db.flush()
        for i, ln in enumerate(payload.lines, start=1):
            co.lines.append(CustomerOrderLine(item_id=ln.item_id, quantity=ln.quantity, note=(ln.note or "").strip() or None, sort_order=i))


@router.post("", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
def create_order(payload: OrderIn, db: Session = Depends(get_db), user: User = Depends(edit)) -> OrderOut:
    co = CustomerOrder(created_by=user.id, manager_id=user.id, status=CO_DRAFT, invoice_no=payload.invoice_no.strip())
    _write(db, co, payload)  # проверки — до добавления в сессию
    db.add(co)
    db.commit()
    db.refresh(co)
    return _out(db, co)


@router.put("/{order_id}", response_model=OrderOut)
def update_order(order_id: int, payload: OrderIn, db: Session = Depends(get_db), user: User = Depends(edit)) -> OrderOut:
    co = _get(db, order_id)
    _check_editable(co, user)
    _write(db, co, payload)
    db.commit()
    db.refresh(co)
    return _out(db, co)


@router.delete("/{order_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_order(order_id: int, db: Session = Depends(get_db), user: User = Depends(edit)) -> None:
    co = _get(db, order_id)
    _check_editable(co, user)
    if cos.progress(db, co).launched > 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "Заказ уже в запуске — отмените его, а не удаляйте")
    db.delete(co)
    db.commit()


class DecisionIn(BaseModel):
    comment: str | None = Field(default=None, max_length=500)
    ship_date: date | None = None
    ready_date: date | None = None


@router.post("/{order_id}/submit", response_model=OrderOut)
def submit(order_id: int, payload: DecisionIn | None = None, db: Session = Depends(get_db), user: User = Depends(edit)) -> OrderOut:
    co = _get(db, order_id)
    if co.status not in (CO_DRAFT, CO_RETURNED):
        raise HTTPException(status.HTTP_409_CONFLICT, "Отправить можно черновик или возвращённый заказ")
    if not co.lines or co.ship_to is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Нужны позиции и вилка отгрузки")
    co.status, co.request_comment = CO_SUBMITTED, ((payload.comment or "").strip() or None) if payload else None
    co.submitted_at, co.submitted_by = datetime.now(timezone.utc), user.id
    co.decided_at = co.decided_by = None
    bitrix.on_request_submitted(db, co, user)
    db.commit()
    db.refresh(co)
    if not co.bitrix_deal_id and deals.enabled(bitrix.get_settings(db)):
        deals.link_in_background(co.id)
    return _out(db, co)


@router.post("/{order_id}/return", response_model=OrderOut)
def return_order(order_id: int, payload: DecisionIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> OrderOut:
    co = _get(db, order_id)
    if co.status != CO_SUBMITTED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Вернуть можно только отправленный заказ")
    comment = (payload.comment or "").strip()
    if not comment:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Напишите, почему возвращаете")
    co.status, co.request_comment = CO_RETURNED, comment
    co.decided_by, co.decided_at = user.id, datetime.now(timezone.utc)
    bitrix.on_request_decided(db, co, accepted=False)
    deals.comment(db, co, f"Производство вернуло заказ менеджеру. Причина: {comment}")
    db.commit()
    db.refresh(co)
    return _out(db, co)


def _log(db: Session, co: CustomerOrder, field: str, old: date | None, new: date | None, uid: int, reason: str | None = None, comment: str | None = None) -> None:
    if old != new:
        db.add(OrderDateChange(customer_order_id=co.id, field=field, old_date=old, new_date=new, reason=reason,
                               comment=(comment or "").strip() or None, user_id=uid))


@router.post("/{order_id}/accept", response_model=OrderOut)
def accept(order_id: int, payload: DecisionIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> OrderOut:
    from app.services.weekly_plan import note_change

    co = _get(db, order_id)
    if co.status != CO_SUBMITTED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Принять можно только отправленный заказ")
    if payload.ship_date is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите дату отгрузки")
    if payload.ready_date and payload.ready_date > payload.ship_date:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Готовность позже отгрузки")
    _log(db, co, "ship", co.ship_date, payload.ship_date, user.id, comment="заказ принят")
    _log(db, co, "ready", co.promised_ready, payload.ready_date, user.id, comment="заказ принят")
    co.ship_date, co.promised_ready = payload.ship_date, payload.ready_date
    co.status, co.request_comment = CO_ACCEPTED, (payload.comment or "").strip() or None
    co.decided_by, co.decided_at = user.id, datetime.now(timezone.utc)
    bitrix.on_request_decided(db, co, accepted=True)
    deals.comment(db, co, f"Заказ принят производством: готовность {deals.fmt(co.promised_ready)}, отгрузка {deals.fmt(co.ship_date)}"
                  + (f". {co.request_comment}" if co.request_comment else ""))
    deals.push_ship_date(db, co)
    note_change(db, co, None, co.promised_ready or co.ship_date, ("СРОЧНЫЙ, " if co.priority == 2 else "") + "принят заказ", user.id)
    db.commit()
    db.refresh(co)
    return _out(db, co)


class PromiseIn(BaseModel):
    ship_date: date | None = None
    ready_date: date | None = None
    ship_from: date | None = None  # вилку двигает менеджер — до приёма
    ship_to: date | None = None
    reason: str | None = None
    comment: str | None = Field(default=None, max_length=500)
    ready_fact: date | None = None


@router.post("/{order_id}/promise", response_model=OrderOut)
def change_dates(order_id: int, payload: PromiseIn, db: Session = Depends(get_db), user: User = Depends(edit)) -> OrderOut:
    """Двигать даты (и из графика отгрузок перетаскиванием): менеджер —
    вилку, пока заказ не принят; производство — обещанные готовность и
    отгрузку, после приёма только с причиной."""
    from app.models.production_orders import ProductionOrder
    from app.services.planning import schedule_order
    from app.services.weekly_plan import note_change

    co = _get(db, order_id)
    if co.status == CO_CANCELLED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Заказ отменён")
    prod = _is_production(user)
    if payload.ship_from or payload.ship_to:
        if not prod and co.status not in (CO_DRAFT, CO_RETURNED, CO_SUBMITTED):
            raise HTTPException(status.HTTP_409_CONFLICT, "Заказ принят — вилку двигать нельзя, договоритесь с производством")
        f, t = payload.ship_from or co.ship_from, payload.ship_to or co.ship_to
        if f and t and f > t:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Вилка: «с» позже, чем «по»")
        co.ship_from, co.ship_to = f, t
    moved = (payload.ship_date and payload.ship_date != co.ship_date) or (payload.ready_date and payload.ready_date != co.promised_ready)
    if moved or payload.ready_fact:
        if not prod:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Обещанные даты двигает производство")
        ship = payload.ship_date or co.ship_date
        ready = payload.ready_date or co.promised_ready
        if ship and ready and ready > ship:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Готовность позже отгрузки")
        if moved and co.status == CO_ACCEPTED:
            if payload.reason not in REASONS:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите причину переноса")
            if payload.reason == "other" and not (payload.comment or "").strip():
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Опишите причину в комментарии")
        old_day = co.promised_ready or co.ship_date
        changes = []
        if payload.ship_date and payload.ship_date != co.ship_date:
            changes.append(("ship", co.ship_date, payload.ship_date))
            _log(db, co, "ship", co.ship_date, payload.ship_date, user.id, payload.reason, payload.comment)
            co.ship_date = payload.ship_date
        if payload.ready_date and payload.ready_date != co.promised_ready:
            changes.append(("ready", co.promised_ready, payload.ready_date))
            _log(db, co, "ready", co.promised_ready, payload.ready_date, user.id, payload.reason, payload.comment)
            co.promised_ready = payload.ready_date
        if payload.ready_fact:
            _log(db, co, "ready_fact", co.ready_at, payload.ready_fact, user.id, payload.reason, payload.comment)
            co.ready_at = payload.ready_fact
        db.flush()
        if changes and co.status == CO_ACCEPTED:
            # запуски этого заказа — к новой дате: срок запуска по самому раннему его заказу
            p = cos.progress(db, co)
            for po_id, _n, st in p.production_orders:
                po = db.get(ProductionOrder, po_id)
                dates = _po_customer_dates(db, po)
                po.promised_ready, po.ship_date = dates
                if st == "released":
                    schedule_order(db, po, user.id)
            note_change(db, co, old_day, co.promised_ready or co.ship_date,
                        "перенос: " + ", ".join(f"{'готовность' if f == 'ready' else 'отгрузка'} {a:%d.%m}→{b:%d.%m}" if a and b else f for f, a, b in changes)
                        + (f" ({REASONS.get(payload.reason or '', '')})" if payload.reason else ""), user.id)
            bitrix.on_promise_changed(db, co, changes, REASONS.get(payload.reason or ""), payload.comment)
            names = {"ship": "отгрузка", "ready": "готовность", "ready_fact": "факт готовности"}
            why = ", ".join(x for x in (REASONS.get(payload.reason or ""), payload.comment) if x)
            deals.comment(db, co, "Перенос дат: " + "; ".join(f"{names.get(f, f)} {deals.fmt(a)} → {deals.fmt(b)}" for f, a, b in changes)
                          + (f". Причина: {why}" if why else ""))
            deals.push_ship_date(db, co)
    db.commit()
    db.refresh(co)
    return _out(db, co)


def _po_customer_dates(db: Session, po) -> tuple[date | None, date | None]:
    ids = {ln.customer_order_line_id for ln in po.lines if ln.customer_order_line_id}
    cos_ = db.query(CustomerOrder).join(CustomerOrderLine).filter(CustomerOrderLine.id.in_(ids or [-1])).all()
    ready = [c.promised_ready for c in cos_ if c.promised_ready]
    ship = [c.ship_date for c in cos_ if c.ship_date]
    return (min(ready) if ready else po.promised_ready, min(ship) if ship else po.ship_date)


class CancelIn(BaseModel):
    reason: str = Field(min_length=2, max_length=255)


class DealOut(BaseModel):
    id: int
    title: str
    stage: str
    amount: float | None
    created: str | None
    url: str | None


@router.get("/{order_id}/bitrix-deals", response_model=list[DealOut])
def find_bitrix_deals(order_id: int, db: Session = Depends(get_db), user: User = Depends(edit)) -> list[DealOut]:
    """Сделки воронки, название которых начинается с номера счёта заказа."""
    co = _get(db, order_id)
    s = bitrix.get_settings(db)
    if not deals.enabled(s):
        raise HTTPException(status.HTTP_409_CONFLICT, "Сделки Битрикс24 не включены — «Настройки → Битрикс24»")
    try:
        found = deals.find_deals(s, co.invoice_no)
    except bitrix.BitrixError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e
    return [DealOut(id=int(d["ID"]), title=d.get("TITLE", ""), stage=d.get("STAGE_ID", ""),
                    amount=float(d["OPPORTUNITY"]) if d.get("OPPORTUNITY") else None, created=(d.get("DATE_CREATE") or "")[:10] or None,
                    url=deals.deal_url(s, int(d["ID"]))) for d in found]


class DealLinkIn(BaseModel):
    deal: str | None = None  # номер сделки или ссылка на неё
    create: bool = False  # создать новую сделку
    unlink: bool = False


@router.post("/{order_id}/bitrix-deal", response_model=OrderOut)
def set_bitrix_deal(order_id: int, payload: DealLinkIn, db: Session = Depends(get_db), user: User = Depends(edit)) -> OrderOut:
    co = _get(db, order_id)
    s = bitrix.get_settings(db)
    if not deals.enabled(s):
        raise HTTPException(status.HTTP_409_CONFLICT, "Сделки Битрикс24 не включены — «Настройки → Битрикс24»")
    try:
        if payload.unlink:
            co.bitrix_deal_id = co.bitrix_stage_sent = None
        elif payload.create:
            if co.bitrix_deal_id:
                raise HTTPException(status.HTTP_409_CONFLICT, "У заказа уже есть сделка — сначала отвяжите её")
            co.bitrix_deal_id, co.bitrix_stage_sent = deals.create_deal(db, s, co), None
        else:
            import re

            m = re.search(r"(\d+)/?\s*$", (payload.deal or "").strip())
            if not m:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите номер сделки или ссылку на неё")
            did = int(m.group(1))
            bitrix.call(s["webhook"], "crm.deal.get", {"id": did})  # есть ли такая
            co.bitrix_deal_id, co.bitrix_stage_sent = did, None
            base = (s.get("base_url") or "").rstrip("/")
            deals.comment(db, co, f"Связана с заказом клиента в программе учёта{': ' + base + '/customer-orders/' + str(co.id) if base else ''}")
    except bitrix.BitrixError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e
    db.commit()
    db.refresh(co)
    return _out(db, co)


@router.post("/{order_id}/cancel", response_model=OrderOut)
def cancel(order_id: int, payload: CancelIn, db: Session = Depends(get_db), user: User = Depends(edit)) -> OrderOut:
    from app.services.weekly_plan import note_change

    co = _get(db, order_id)
    if not _is_production(user) and co.status == CO_ACCEPTED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Принятый заказ отменяет производство")
    p = cos.progress(db, co)
    if p.in_work > 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "Заказ в производстве — сначала уменьшите или отмените его в заказе на производство")
    if p.launched > 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "Заказ собран в черновик запуска — сначала уберите его строки из черновика или удалите черновик")
    old = co.promised_ready or co.ship_date
    co.status = CO_CANCELLED
    co.note = (f"Отменён: {payload.reason}. " + (co.note or ""))[:500]
    note_change(db, co, old, None, f"отменён ({payload.reason})", user.id)
    deals.comment(db, co, f"Заказ отменён в программе. Причина: {payload.reason}")
    from app.services import film_reserve

    film_reserve.release_customer_order(db, co.id, user.id, f"заказ отменён: {payload.reason}")
    db.commit()
    db.refresh(co)
    return _out(db, co)


@router.get("/{order_id}/plan-check")
def plan_check(order_id: int, db: Session = Depends(get_db), user: User = Depends(view)) -> dict:
    """Когда раньше всего может быть готово (незапущенный остаток заказа)."""
    from app.services.order_requests import plan_check as _check

    co = _get(db, order_id)
    try:
        po = cos.transient_production_order(db, co, user.id)
        if po is None:
            return {"earliest": None, "by_route": None, "bottleneck": None, "fits": None, "areas": [], "error": "Всё уже запущено — смотрите заказ на производство"}
        po.ship_to = co.ship_to
        r = _check(db, po, user.id)
        return {"earliest": r.earliest, "by_route": r.by_route, "bottleneck": r.bottleneck, "fits": r.fits, "error": r.error,
                "areas": [a.__dict__ for a in r.areas]}
    finally:
        db.rollback()


class LaunchIn(BaseModel):
    order_ids: list[int] = Field(min_length=1)
    name: str | None = Field(default=None, max_length=255)


@router.post("/launch")
def launch(payload: LaunchIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> dict:
    """Собрать запуск: черновик заказа на производство из принятых заказов
    клиентов — дальше обычное окно запуска (п/ф, площадки, сроки)."""
    orders = [_get(db, i) for i in payload.order_ids]
    bad = [co.invoice_no for co in orders if co.status != CO_ACCEPTED]
    if bad:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Не приняты производством: {', '.join(bad)}")
    try:
        po = cos.build_production_order(db, orders, user.id, payload.name)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    return {"production_order_id": po.id}


class ImportIn(BaseModel):
    text: str
    type_id: int
    invoice_no: str | None = None
    customer: str | None = None
    ship_from: date | None = None
    ship_to: date | None = None
    dry_run: bool = True
    color_films: dict[str, int] = {}


@router.post("/import")
def import_orders(payload: ImportIn, db: Session = Depends(get_db), user: User = Depends(edit)) -> dict:
    """Счёт 1С целиком или график запуска: строки → позиции по типу
    (находятся или создаются по правилам), заказ клиента на каждый счёт.
    dry_run — предпросмотр. Номер счёта, которого ещё нет в заказах."""
    from app.models.production_orders import ProductionOrder
    from app.services.schedule_import import import_schedule

    type_ = db.get(ItemType, payload.type_id)
    if type_ is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Тип не найден")
    colors: list = []
    rows, errors, po = import_schedule(
        db, text=payload.text, type_=type_, order_name="импорт заказов клиентов", user_id=user.id, dry_run=payload.dry_run,
        color_films=payload.color_films, colors_out=colors, invoice_no=(payload.invoice_no or "").strip() or None,
    )
    out_rows = [{k: getattr(r, k) for k in ("series", "size", "color", "name_text", "qty", "invoice_no", "ship_date", "item_name", "exists", "errors", "notes")} for r in rows]
    invoices = sorted({(r.invoice_no or "").strip() for r in rows if (r.invoice_no or "").strip()})
    no_inv = [r.name_text for r in rows if not (r.invoice_no or "").strip()]
    taken = [i for (i,) in db.query(CustomerOrder.invoice_no).filter(CustomerOrder.invoice_no.in_(invoices))] if invoices else []
    problems = list(errors)
    if no_inv:
        problems.append(f"Строки без номера счёта ({len(no_inv)}) — укажите счёт")
    if taken:
        problems.append(f"Заказы по счетам уже есть: {', '.join(taken)}")
    if payload.dry_run or po is None or problems:
        db.rollback()
        return {"rows": out_rows, "problems": problems, "invoices": invoices, "colors": [c.__dict__ for c in colors], "created": []}
    # вилка «по» — дата отгрузки из графика, если не задана целиком
    ship_by_inv: dict[str, date] = {}
    for r in rows:
        if r.ship_date and (r.invoice_no or "").strip():
            d = date.fromisoformat(str(r.ship_date)[:10])
            inv = r.invoice_no.strip()
            ship_by_inv[inv] = max(ship_by_inv.get(inv, d), d)
    by_inv: dict[str, CustomerOrder] = {}
    for i, ln in enumerate(sorted(po.lines, key=lambda x: x.sort_order), start=1):
        inv = (ln.invoice_no or "").strip()
        co = by_inv.get(inv)
        if co is None:
            co = CustomerOrder(invoice_no=inv, customer=(payload.customer or "").strip() or None, created_by=user.id, manager_id=user.id,
                               status=CO_DRAFT, ship_from=payload.ship_from, ship_to=payload.ship_to or ship_by_inv.get(inv))
            db.add(co)
            by_inv[inv] = co
        co.lines.append(CustomerOrderLine(item_id=ln.item_id, quantity=ln.quantity, note=ln.note, source_text=ln.source_text, sort_order=i))
    db.delete(db.get(ProductionOrder, po.id))
    db.flush()
    created = [co.id for co in by_inv.values()]
    db.commit()
    return {"rows": out_rows, "problems": [], "invoices": invoices, "colors": [], "created": created}
