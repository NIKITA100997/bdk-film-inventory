"""Заказы клиентов (13.10): заказ = один счёт 1С. Менеджер заводит
(вручную или из счёта/графика), ставит вилку отгрузки и приоритет,
проверяет срок, отправляет; производство принимает с обещанными
готовностью и отгрузкой или возвращает; переносы — с причиной; принятые
заказы начальник производства собирает в заказ на производство."""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
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
from app.services import line_options
from app.services.components import live_item_names

router = APIRouter(prefix="/customer-orders", tags=["customer-orders"])
view = require_permission("production_tasks.manage", "production_tasks.view", "production_tasks.report", "orders.request", "sales_calculator.view", "plan.approve")
edit = require_permission("production_tasks.manage", "orders.request")
manage = require_permission("production_tasks.manage")

REASONS = {
    "material": "Нет материала", "capacity": "Перегруз участка", "client": "Просьба клиента", "defect": "Брак, переделка",
    "equipment": "Поломка оборудования", "calendar": "Нерабочий день", "urgent": "Вставили срочный заказ", "other": "Другое",
    "manager": "Уточнено менеджером",
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
    options: list[dict] | None = None  # исполнение (26.10); None — не менять


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
    direction: str | None = None  # код вида: trim / shield / tsarg / panel (сделки по видам)
    kind_name: str | None = None
    received: float = 0  # принято на склад ГП (по запуску или «Готово…» без запуска)  # вид позиции — запуск по видам (погонаж отдельно от дверей, 20.10)
    # исполнение (26.10): [{code, name, value, op}] и какие выборы есть у типа позиции
    options: list[dict] = []
    option_fields: list[dict] = []
    source_text: str | None = None


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
    # сделки по видам (20.10): [{deal_id, direction, direction_label, title, url, stage}]
    bitrix_deals: list[dict] = []


def _out(db: Session, co: CustomerOrder, full: bool = True) -> OrderOut:
    from app.models.production_orders import ProductionOrder
    from app.services.planning import order_plan_status

    p = cos.progress(db, co)
    names = live_item_names(db, {ln.item_id for ln in co.lines})
    # вид для запуска (20.10): направление позиции — щитовые / царговые /
    # панели / погонаж; нет направления — тип, иначе вид номенклатуры
    from app.models.items import ItemKind
    from app.services.item_attrs import DIRECTIONS, effective_direction

    kind_of: dict[int, str] = {}
    dir_of: dict[int, str | None] = {}
    if True:  # и в списке (27.10): вид строк нужен в окне «Собрать запуск»
        its = db.query(Item).filter(Item.id.in_({ln.item_id for ln in co.lines} or {-1})).all()
        tps = {t.id: t for t in db.query(ItemType).filter(ItemType.id.in_({i.type_id for i in its if i.type_id} or {-1}))}
        kn = {k.id: k.name for k in db.query(ItemKind)}
        for it in its:
            tp = tps.get(it.type_id) if it.type_id else None
            d = effective_direction(it, tp)
            dir_of[it.id] = d
            kind_of[it.id] = DIRECTIONS.get(d) if d else (tp.name if tp else kn.get(it.kind_id, ""))
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
                       launched=round(p.line_launched.get(ln.id, 0.0), 2), note=ln.note, kind_name=kind_of.get(ln.item_id), direction=dir_of.get(ln.item_id),
                       received=round(p.line_received.get(ln.id, 0.0), 2), options=ln.options or [],
                       option_fields=line_options.option_fields(db, db.get(Item, ln.item_id)) if full else [],
                       source_text=ln.source_text) for ln in co.lines],
        date_changes=changes,
        bitrix_deal_id=co.bitrix_deal_id,
        bitrix_deal_url=deals.deal_url(bitrix.get_settings(db), co.bitrix_deal_id) if co.bitrix_deal_id else None,
        bitrix_deals_on=full and deals.enabled(bitrix.get_settings(db)),
        bitrix_deals=_deal_rows(db, co) if full else [],
    )


def _deal_rows(db: Session, co: CustomerOrder) -> list[dict]:
    from app.services.item_attrs import DIRECTIONS

    s = bitrix.get_settings(db)
    dirs = None
    out = []
    for link in deals.deal_links(db, co):
        if link.direction is None:
            st = cos.progress(db, co).stage
        else:
            dirs = dirs or deals.line_directions(db, co)
            st = cos.progress(db, co, only={i for i, d in dirs.items() if d == link.direction}).stage
        out.append({"deal_id": link.deal_id, "direction": link.direction,
                    "direction_label": DIRECTIONS.get(link.direction) if link.direction else "весь заказ",
                    "title": link.title, "url": deals.deal_url(s, link.deal_id), "stage": cos.STAGE_LABEL.get(st, "")})
    return out


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
    rows = calendar(db, date_from, date_to)
    # внутренние заказы производства (задания окутки, погонаж без заказа
    # клиента) — продажникам не показываем (20.10): у них только заказы клиентов
    if not _is_production(user):
        rows = [r for r in rows if r.kind == "co"]
    return [CalendarRowOut(**asdict(r)) for r in rows]


@router.get("/{order_id}", response_model=OrderOut)
def get_order(order_id: int, db: Session = Depends(get_db), user: User = Depends(view)) -> OrderOut:
    return _out(db, _get(db, order_id))


def _write(db: Session, co: CustomerOrder, payload: OrderIn) -> None:
    inv = payload.invoice_no.strip()
    dup = cos.find_by_invoice(db, inv, exclude_id=co.id)
    if dup:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Заказ по счёту {dup.invoice_no} уже есть — №{dup.id}: откройте его и дополните")
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
                if ln.options is not None:
                    ex.options = ln.options or None
            else:
                co.lines.append(CustomerOrderLine(item_id=ln.item_id, quantity=ln.quantity, note=(ln.note or "").strip() or None, sort_order=i,
                                                  options=ln.options or None))
        for ex in by_item.values():
            if launched.get(ex.id):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Запущенную позицию нельзя убрать — отмените её в заказе на производство")
            co.lines.remove(ex)
    else:
        db.flush()
        for i, ln in enumerate(payload.lines, start=1):
            co.lines.append(CustomerOrderLine(item_id=ln.item_id, quantity=ln.quantity, note=(ln.note or "").strip() or None, sort_order=i,
                                              options=ln.options or None))


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
    if deals.enabled(bitrix.get_settings(db)):
        deals.link_in_background(co.id)  # сделки по видам — найти или создать недостающие
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
    # производство принимает и без отправки (20.10): заказ из сделки,
    # царговые — просто проставить даты, без запуска
    if co.status not in (CO_SUBMITTED, CO_DRAFT, CO_RETURNED):
        raise HTTPException(status.HTTP_409_CONFLICT, "Заказ уже принят или отменён")
    if not co.lines:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "В заказе нет позиций")
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


class LineReadyIn(BaseModel):
    qty: float = Field(gt=0)
    site_id: int | None = None


@router.post("/{order_id}/lines/{line_id}/ready", response_model=OrderOut)
def line_ready(order_id: int, line_id: int, payload: LineReadyIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> OrderOut:
    """«Готово…» по строке принятого заказа без запуска (20.10): приход на
    склад ГП; заказ «готов», когда готово всё, — сделка на «Склад ГП»."""
    co = _get(db, order_id)
    line = next((ln for ln in co.lines if ln.id == line_id), None)
    if line is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Строка не найдена")
    try:
        cos.mark_ready_without_launch(db, co, line, payload.qty, payload.site_id, user.id)
    except ValueError as e:
        db.rollback()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    db.refresh(co)
    return _out(db, co)


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
    if not deals.connected(s):
        raise HTTPException(status.HTTP_409_CONFLICT, "Битрикс24 не подключён или не выбрана воронка — «Настройки → Битрикс24»")
    try:
        found = deals.find_deals(s, co.invoice_no)
    except bitrix.BitrixError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e
    return [DealOut(id=int(d["ID"]), title=d.get("TITLE", ""), stage=d.get("STAGE_ID", ""),
                    amount=float(d["OPPORTUNITY"]) if d.get("OPPORTUNITY") else None, created=(d.get("DATE_CREATE") or "")[:10] or None,
                    url=deals.deal_url(s, int(d["ID"]))) for d in found]


class FunnelDealOut(BaseModel):
    id: int
    title: str
    invoice: str | None
    kind: str | None
    qty: int | None
    amount: float | None
    stage: str
    stage_name: str
    closed: bool
    company: str | None
    assigned: str | None
    assigned_bx: int | None
    created: str | None
    url: str | None
    ship_date: str | None = None  # «Дата отгрузки» сделки (20.10)
    state: str  # linked — у заказа; match — один подходящий заказ; many — несколько; none — заказа нет
    order_id: int | None = None
    order_invoice: str | None = None
    order_stage: str | None = None
    candidates: list[dict] = []


class FunnelOut(BaseModel):
    deals: list[FunnelDealOut]
    orders_without_deal: list[dict]
    sync_enabled: bool
    auto_create: bool
    loaded_at: float


def _funnel(db: Session, s: dict, refresh: bool) -> FunnelOut:
    data = deals.funnel_deals(s, refresh)
    from app.models.customer_orders import CustomerOrderDeal

    orders = db.query(CustomerOrder).filter(CustomerOrder.status != CO_CANCELLED).all()
    by_id = {co.id: co for co in orders}
    by_deal = {link.deal_id: by_id[link.order_id] for link in db.query(CustomerOrderDeal) if link.order_id in by_id}
    by_deal.update({co.bitrix_deal_id: co for co in orders if co.bitrix_deal_id and co.bitrix_deal_id not in by_deal})
    # заказ без сделки нужного вида — кандидат и для второй, третьей сделки счёта
    free = orders
    out: list[FunnelDealOut] = []
    matched_cos: set[int] = set()
    for d in data["deals"]:
        did = int(d["ID"])
        inv, kind, qty = deals.parse_title(d.get("TITLE", ""))
        row = dict(
            id=did, title=d.get("TITLE", ""), invoice=inv, kind=kind, qty=qty,
            amount=float(d["OPPORTUNITY"]) if d.get("OPPORTUNITY") else None,
            stage=d.get("STAGE_ID", ""), stage_name=data["stages"].get(d.get("STAGE_ID", ""), d.get("STAGE_ID", "")),
            closed=d.get("CLOSED") == "Y", company=data["companies"].get(d.get("COMPANY_ID") or ""),
            assigned=data["users"].get(d.get("ASSIGNED_BY_ID") or ""),
            assigned_bx=int(d["ASSIGNED_BY_ID"]) if d.get("ASSIGNED_BY_ID") else None,
            created=(d.get("DATE_CREATE") or "")[:10] or None, url=deals.deal_url(s, did),
            ship_date=d.get("SHIP"),
        )
        co = by_deal.get(did)
        if co is not None:
            row.update(state="linked", order_id=co.id, order_invoice=co.invoice_no, order_stage=cos_stage(db, co))
        else:
            cands = [c for c in free if deals.title_matches(row["title"], c.invoice_no)]
            row["candidates"] = [{"id": c.id, "invoice": c.invoice_no, "customer": c.customer} for c in cands]
            row["state"] = "match" if len(cands) == 1 else ("many" if cands else "none")
            matched_cos.update(c.id for c in cands)
        out.append(FunnelDealOut(**row))
    without = [{"id": c.id, "invoice": c.invoice_no, "customer": c.customer, "stage": cos_stage(db, c)}
               for c in free if c.id not in matched_cos and c not in by_deal.values()]  # без единой сделки
    return FunnelOut(deals=out, orders_without_deal=without, sync_enabled=deals.enabled(s),
                     auto_create=bool(s.get("deal_auto_create")), loaded_at=data["loaded_at"])


def cos_stage(db: Session, co: CustomerOrder) -> str:
    return cos.STAGE_LABEL.get(cos.progress(db, co).stage, "")


@router.get("/bitrix/funnel", response_model=FunnelOut)
def bitrix_funnel(refresh: bool = False, db: Session = Depends(get_db), user: User = Depends(view)) -> FunnelOut:
    """Все сделки воронки Битрикс24 против заказов клиентов (19.10): у
    заказа / можно привязать / заказа нет; и заказы без сделки."""
    s = bitrix.get_settings(db)
    if not deals.connected(s):
        raise HTTPException(status.HTTP_409_CONFLICT, "Битрикс24 не подключён или не выбрана воронка — «Настройки → Битрикс24»")
    try:
        return _funnel(db, s, refresh)
    except bitrix.BitrixError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e


class CalendarDealsOut(BaseModel):
    dated: list[FunnelDealOut]  # открытые, без заказа, с датой отгрузки в периоде
    undated: list[FunnelDealOut]  # открытые, без заказа, без даты отгрузки
    connected: bool


@router.get("/calendar/deals", response_model=CalendarDealsOut)
def calendar_deals(date_from: date, date_to: date, refresh: bool = False, db: Session = Depends(get_db), user: User = Depends(view)) -> CalendarDealsOut:
    """Сделки Битрикса в календаре заказов (20.10): открытые сделки воронки,
    по которым ещё нет заказа клиента, — на их дату отгрузки; из сделки —
    «Создать заказ клиента». Сделки с заказом — уже строками заказов."""
    s = bitrix.get_settings(db)
    if not deals.connected(s):
        return CalendarDealsOut(dated=[], undated=[], connected=False)
    try:
        f = _funnel(db, s, refresh)
    except bitrix.BitrixError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e
    # не привязанные к заказу; счёт уже есть в заказах (другой вид — «щиты» к
    # заказу с погонажем) — с номером заказа: дополнить его, а не заводить новый
    from app.services.invoice_1c import invoice_key

    by_key = {c.invoice_key: c.id for c in db.query(CustomerOrder).filter(CustomerOrder.status != CO_CANCELLED) if c.invoice_key}
    free = []
    for d in f.deals:
        if d.closed or d.state == "linked":
            continue
        oid = by_key.get(invoice_key(d.invoice)) if d.invoice else None
        free.append(d.model_copy(update={"order_id": oid}))
    dated = [d for d in free if d.ship_date and date_from.isoformat() <= d.ship_date <= date_to.isoformat()]
    undated = [d for d in free if not d.ship_date]
    return CalendarDealsOut(dated=dated, undated=undated, connected=True)


@router.post("/bitrix/link-all")
def bitrix_link_all(db: Session = Depends(get_db), user: User = Depends(edit)) -> dict:
    """Привязать все однозначные пары «сделка ↔ заказ» (один заказ на сделку
    и одна сделка на заказ). Неоднозначные — вручную."""
    s = bitrix.get_settings(db)
    if not deals.connected(s):
        raise HTTPException(status.HTTP_409_CONFLICT, "Битрикс24 не подключён или не выбрана воронка — «Настройки → Битрикс24»")
    try:
        f = _funnel(db, s, refresh=True)
    except bitrix.BitrixError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e
    # по видам (20.10): у заказа — по сделке на вид его строк («пог.», «щиты»,
    # «царга»); одна сделка вида — привязать, несколько — вручную
    per_order: dict[int, list] = {}
    for d in f.deals:
        if d.state != "linked":
            for c in d.candidates:
                per_order.setdefault(c["id"], []).append(d)
    linked = 0
    for oid, cands in per_order.items():
        co = db.get(CustomerOrder, oid)
        links = deals.deal_links(db, co)
        if any(link.direction is None for link in links):
            continue
        need = set(deals.line_directions(db, co).values()) - {link.direction for link in links}
        for dr in need:
            same = [d for d in cands if deals.direction_of_title(d.title) == dr]
            if not same and len(need) == 1 and not links and len(cands) == 1 and deals.direction_of_title(cands[0].title) is None:
                same = cands
            if len(same) == 1:
                deals.link_deal(db, co, same[0].id, dr, same[0].title)
                linked += 1
    db.commit()
    return {"linked": linked}


class DealLinkIn(BaseModel):
    deal: str | None = None  # номер сделки или ссылка на неё
    create: bool = False  # создать новую сделку
    unlink: bool = False  # с deal — отвязать эту, без — все
    # вид строк, которые ведёт сделка (20.10): trim / shield / tsarg / panel; "" — весь заказ; нет — по названию сделки
    direction: str | None = None


@router.post("/{order_id}/bitrix-deal", response_model=OrderOut)
def set_bitrix_deal(order_id: int, payload: DealLinkIn, db: Session = Depends(get_db), user: User = Depends(edit)) -> OrderOut:
    co = _get(db, order_id)
    s = bitrix.get_settings(db)
    if not deals.connected(s):
        raise HTTPException(status.HTTP_409_CONFLICT, "Битрикс24 не подключён или не выбрана воронка — «Настройки → Битрикс24»")
    try:
        import re

        did_in = re.search(r"(\d+)/?\s*$", (payload.deal or "").strip())
        direction = (payload.direction or None) if payload.direction is not None else None
        if payload.unlink:
            deals.unlink_deal(db, co, int(did_in.group(1)) if did_in else None)
        elif payload.create:
            if any(link.direction is None or link.direction == direction for link in deals.deal_links(db, co)):
                raise HTTPException(status.HTTP_409_CONFLICT, "Сделка на эти строки уже есть — сначала отвяжите её")
            deals.link_deal(db, co, deals.create_deal(db, s, co, direction), direction)
        else:
            if not did_in:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите номер сделки или ссылку на неё")
            did = int(did_in.group(1))
            deal = bitrix.call(s["webhook"], "crm.deal.get", {"id": did}).get("result") or {}  # есть ли такая
            title = deal.get("TITLE")
            if payload.direction is None:
                direction = deals.direction_of_title(title or "")
            deals.link_deal(db, co, did, direction, title)
            base = (s.get("base_url") or "").rstrip("/")
            bitrix.enqueue(db, "deal_comment", "crm.timeline.comment.add", {"fields": {
                "ENTITY_ID": did, "ENTITY_TYPE": "deal",
                "COMMENT": f"Связана с заказом клиента в программе учёта{': ' + base + '/customer-orders/' + str(co.id) if base else ''}"}})
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
    # только эти строки заказов (20.10): погонаж отдельно от дверей; нет — все незапущенные
    line_ids: list[int] | None = None


@router.post("/launch")
def launch(payload: LaunchIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> dict:
    """Собрать запуск: черновик заказа на производство из принятых заказов
    клиентов — дальше обычное окно запуска (п/ф, площадки, сроки)."""
    orders = [_get(db, i) for i in payload.order_ids]
    bad = [co.invoice_no for co in orders if co.status != CO_ACCEPTED]
    if bad:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Не приняты производством: {', '.join(bad)}")
    try:
        po = cos.build_production_order(db, orders, user.id, payload.name, set(payload.line_ids) if payload.line_ids else None)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    return {"production_order_id": po.id}


@router.post("/invoice-file")
async def read_invoice_file(file: UploadFile = File(...), user: User = Depends(edit)) -> dict:
    """Выгрузка счёта из 1С (.xls/.xlsx): номер счёта — имя файла, строки —
    «наименование<TAB>кол-во» для окна импорта. Ничего не создаёт."""
    from app.services.invoice_1c import invoice_no_from_filename, read_invoice

    try:
        lines, problems = read_invoice(await file.read(), file.filename or "")
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    return {
        "invoice_no": invoice_no_from_filename(file.filename or ""),
        "text": "\n".join(f"{name}\t{qty}" for name, qty in lines),
        "lines": len(lines),
        "problems": problems,
    }


class ImportIn(BaseModel):
    text: str
    type_id: int | None = None  # нет — тип строки по серии (16.10)
    invoice_no: str | None = None
    customer: str | None = None
    ship_from: date | None = None
    ship_to: date | None = None
    dry_run: bool = True
    color_films: dict[str, int] = {}
    # заказ из сделки Битрикс24 (19.10): сделка привязывается, сумма и менеджер — из неё
    bitrix_deal_id: int | None = None
    item_choices: dict[str, int] = {}  # строка счёта → выбранная позиция (21.10)
    bitrix_deal_title: str | None = None  # вид сделки по названию («пог.», «щиты») — 20.10
    amount_rub: float | None = None
    manager_bitrix_id: int | None = None


@router.post("/import")
def import_orders(payload: ImportIn, db: Session = Depends(get_db), user: User = Depends(edit)) -> dict:
    """Счёт 1С целиком или график запуска: строки → позиции по типу
    (находятся или создаются по правилам), заказ клиента на каждый счёт.
    dry_run — предпросмотр. Номер счёта, которого ещё нет в заказах."""
    from app.models.production_orders import ProductionOrder
    from app.services.schedule_import import import_schedule, import_types

    type_, others = import_types(db, payload.type_id)
    if type_ is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Тип не найден")
    colors: list = []
    rows, errors, po = import_schedule(
        db, text=payload.text, type_=type_, order_name="импорт заказов клиентов", user_id=user.id, dry_run=payload.dry_run,
        color_films=payload.color_films, colors_out=colors, invoice_no=(payload.invoice_no or "").strip() or None,
        other_types=others, item_choices=payload.item_choices,
    )
    out_rows = [{k: getattr(r, k) for k in ("series", "size", "color", "name_text", "qty", "invoice_no", "ship_date", "item_name", "exists", "type_name", "errors", "notes", "candidates", "options")} for r in rows]
    invoices = sorted({(r.invoice_no or "").strip() for r in rows if (r.invoice_no or "").strip()})
    no_inv = [r.name_text for r in rows if not (r.invoice_no or "").strip()]
    # один счёт — один заказ (20.10): счёт, по которому заказ уже есть, —
    # дополняет его (новые позиции, количество, актуальная дата отгрузки)
    existing = {inv: cos.find_by_invoice(db, inv) for inv in invoices}
    existing = {inv: co for inv, co in existing.items() if co is not None}
    problems = list(errors)
    if no_inv:
        problems.append(f"Строки без номера счёта ({len(no_inv)}) — укажите счёт")
    cancelled = [co.invoice_no for co in existing.values() if co.status == CO_CANCELLED]
    if cancelled:
        problems.append(f"Заказы по счетам отменены: {', '.join(cancelled)} — заведите заново после удаления отменённого")
    merges = [{"invoice": inv, "order_id": co.id, "order_invoice": co.invoice_no, "status": co.status} for inv, co in existing.items()]
    if payload.dry_run or po is None or problems:
        db.rollback()
        return {"rows": out_rows, "problems": problems, "invoices": invoices, "colors": [c.__dict__ for c in colors], "created": [], "merges": merges}
    # вилка «по» — дата отгрузки из графика, если не задана целиком
    ship_by_inv: dict[str, date] = {}
    for r in rows:
        if r.ship_date and (r.invoice_no or "").strip():
            d = date.fromisoformat(str(r.ship_date)[:10])
            inv = r.invoice_no.strip()
            ship_by_inv[inv] = max(ship_by_inv.get(inv, d), d)
    by_inv: dict[str, CustomerOrder] = {}
    link_after: list[tuple[CustomerOrder, int]] = []  # сделка — к новому заказу после flush
    po_lines = sorted(po.lines, key=lambda x: x.sort_order)
    updated: list[int] = []
    for inv, co in existing.items():
        cos.merge_lines(db, co, [(ln.item_id, float(ln.quantity), ln.note, ln.source_text, ln.options) for ln in po_lines if (ln.invoice_no or "").strip() == inv])
        if payload.customer and not co.customer:
            co.customer = payload.customer.strip()
        if payload.bitrix_deal_id and len(invoices) == 1:
            deals.link_deal(db, co, payload.bitrix_deal_id, deals.direction_of_title(payload.bitrix_deal_title or ""), payload.bitrix_deal_title)
        cos.apply_actual_ship_date(db, co, payload.ship_to or ship_by_inv.get(inv), user.id, "счёт загружен повторно")
        updated.append(co.id)
    for i, ln in enumerate(po_lines, start=1):
        inv = (ln.invoice_no or "").strip()
        if inv in existing:
            continue
        co = by_inv.get(inv)
        if co is None:
            mgr = None
            if payload.manager_bitrix_id:
                mgr = db.query(User).filter(User.bitrix_user_id == payload.manager_bitrix_id, User.is_active.is_(True)).first()
            co = CustomerOrder(invoice_no=inv, customer=(payload.customer or "").strip() or None, created_by=user.id,
                               manager_id=mgr.id if mgr else user.id,
                               status=CO_DRAFT, ship_from=payload.ship_from, ship_to=payload.ship_to or ship_by_inv.get(inv))
            if payload.bitrix_deal_id and len(invoices) == 1:
                link_after.append((co, payload.bitrix_deal_id))
                if payload.amount_rub:
                    co.amount_rub = payload.amount_rub
            db.add(co)
            by_inv[inv] = co
        co.lines.append(CustomerOrderLine(item_id=ln.item_id, quantity=ln.quantity, note=ln.note, source_text=ln.source_text, sort_order=i,
                                          options=ln.options))
    db.delete(db.get(ProductionOrder, po.id))
    db.flush()
    for co, did in link_after:
        deals.link_deal(db, co, did, deals.direction_of_title(payload.bitrix_deal_title or ""), payload.bitrix_deal_title)
    created = [co.id for co in by_inv.values()]
    db.commit()
    return {"rows": out_rows, "problems": [], "invoices": invoices, "colors": [], "created": created, "updated": updated, "merges": merges}


class LineOptionsIn(BaseModel):
    options: list[dict] = []


@router.patch("/{order_id}/lines/{line_id}/options", response_model=OrderOut)
def set_line_options(order_id: int, line_id: int, payload: LineOptionsIn, db: Session = Depends(get_db), user: User = Depends(edit)) -> OrderOut:
    """Исполнение строки (26.10): цвет кромки, тип стекла, уплотнитель… —
    дописать то, чего не было в счёте. Не запущенные строки заказов на
    производство (черновики) получают то же."""
    from app.models.production_orders import ORDER_DRAFT, ProductionOrder, ProductionOrderLine

    co = _get(db, order_id)
    ln = next((x for x in co.lines if x.id == line_id), None)
    if ln is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Строка не найдена")
    opts = [o for o in line_options.merge([], payload.options) if (o.get("value") or "").strip()]
    ln.options = opts or None
    for pol in (
        db.query(ProductionOrderLine).join(ProductionOrder, ProductionOrder.id == ProductionOrderLine.order_id)
        .filter(ProductionOrderLine.customer_order_line_id == ln.id, ProductionOrder.status == ORDER_DRAFT)
    ):
        pol.options = ln.options
    db.commit()
    return _out(db, co)
