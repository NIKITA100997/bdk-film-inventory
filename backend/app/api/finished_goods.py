"""Склад готовой продукции и отгрузка по счёту (06.10). Модель —
models/finished_goods.py, приход от упаковки — services/finished_goods.py."""
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import get_current_user, get_permission_codes, require_permission
from app.db.session import get_db
from app.models.finished_goods import (
    FG_ADJUST,
    FG_RETURN,
    FG_SHIPMENT,
    FG_TRANSFER,
    FG_UNSHIP,
    SHIP_CANCELLED,
    SHIP_DONE,
    FgMove,
    FgShipment,
)
from app.models.items import Item
from app.models.production_orders import ORDER_DRAFT, ProductionOrder, ProductionOrderLine
from app.models.sites import Site
from app.models.users import User
from app.services.finished_goods import balances, totals_by_order_line

router = APIRouter(prefix="/finished-goods", tags=["finished-goods"])
ship_fg = require_permission("fg.ship")


def _names(db: Session):
    sites = {s.id: s.name for s in db.query(Site)}
    users = {u.id: (u.full_name or u.username) for u in db.query(User)}
    return sites, users


# ---------- остатки ----------
class StockRow(BaseModel):
    item_id: int
    item_name: str
    site_id: int | None
    site_name: str | None
    order_line_id: int | None
    order_id: int | None
    order_name: str | None
    invoice_no: str | None
    qty: float
    # Себестоимость (08.10, services/lot_cost.py) — тем, у кого права на цены:
    # под заказ — по строке заказа, на склад — средняя по позиции.
    unit_cost_rub: float | None = None
    value_rub: float | None = None


@router.get("/stock", response_model=list[StockRow])
def stock(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[StockRow]:
    """Остатки готовой продукции: позиция × площадка × строка заказа (счёт)."""
    bals = [b for b in balances(db) if b.qty > 0]
    items = {i.id: i.name for i in db.query(Item).filter(Item.id.in_({b.item_id for b in bals}))} if bals else {}
    ols = (
        {ol.id: ol for ol in db.query(ProductionOrderLine).filter(ProductionOrderLine.id.in_({b.order_line_id for b in bals if b.order_line_id}))}
        if bals
        else {}
    )
    orders = {o.id: o.name for o in db.query(ProductionOrder).filter(ProductionOrder.id.in_({ol.order_id for ol in ols.values()}))} if ols else {}
    sites, _ = _names(db)
    from app.services.lot_cost import fg_avg_cost, order_line_unit_cost

    see_cost = user.is_superuser or bool({"prices.view", "prices.manage"} & get_permission_codes(user))
    out = []
    for b in bals:
        ol = ols.get(b.order_line_id) if b.order_line_id else None
        unit = None
        if see_cost:
            unit = (order_line_unit_cost(db, b.order_line_id) if b.order_line_id else None) or fg_avg_cost(db, b.item_id, set())
        out.append(
            StockRow(
                item_id=b.item_id, item_name=items.get(b.item_id, f"#{b.item_id}"), site_id=b.site_id, site_name=sites.get(b.site_id),
                order_line_id=b.order_line_id, order_id=ol.order_id if ol else None, order_name=orders.get(ol.order_id) if ol else None,
                invoice_no=ol.invoice_no if ol else None, qty=b.qty,
                unit_cost_rub=unit, value_rub=round(unit * b.qty, 2) if unit is not None else None,
            )
        )
    return sorted(out, key=lambda r: (r.invoice_no or "яяя", r.item_name))


class MoveRow(BaseModel):
    id: int
    occurred_at: datetime
    kind: str
    item_id: int
    item_name: str
    qty: float
    site_name: str | None
    invoice_no: str | None
    order_id: int | None
    shipment_id: int | None
    note: str | None
    user_name: str | None


@router.get("/moves", response_model=list[MoveRow])
def moves(limit: int = 500, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[MoveRow]:
    rows = db.query(FgMove).order_by(FgMove.occurred_at.desc(), FgMove.id.desc()).limit(min(limit, 2000)).all()
    items = {i.id: i.name for i in db.query(Item).filter(Item.id.in_({m.item_id for m in rows}))} if rows else {}
    ols = {ol.id: ol.order_id for ol in db.query(ProductionOrderLine).filter(ProductionOrderLine.id.in_({m.order_line_id for m in rows if m.order_line_id}))} if rows else {}
    sites, users = _names(db)
    return [
        MoveRow(
            id=m.id, occurred_at=m.occurred_at, kind=m.kind, item_id=m.item_id, item_name=items.get(m.item_id, ""), qty=float(m.qty),
            site_name=sites.get(m.site_id), invoice_no=m.invoice_no, order_id=ols.get(m.order_line_id) if m.order_line_id else None,
            shipment_id=m.shipment_id, note=m.note, user_name=users.get(m.user_id),
        )
        for m in rows
    ]


# ---------- счета: что заказано, упаковано, отгружено, на складе ----------
class InvoiceLine(BaseModel):
    order_line_id: int
    order_id: int
    order_name: str
    item_id: int
    item_name: str
    ordered: float
    received: float
    shipped: float
    on_stock: float
    by_site: dict[str, float]  # site_id → на складе


class InvoiceSummary(BaseModel):
    invoice_no: str
    orders: list[str]
    ordered: float
    received: float
    shipped: float
    on_stock: float
    lines: list[InvoiceLine]


def _invoice_lines(db: Session, invoice_no: str | None = None) -> dict[str, list[InvoiceLine]]:
    q = db.query(ProductionOrderLine, ProductionOrder).join(ProductionOrder, ProductionOrder.id == ProductionOrderLine.order_id).filter(
        ProductionOrderLine.invoice_no.isnot(None), ProductionOrderLine.invoice_no != "", ProductionOrder.status != ORDER_DRAFT
    )  # черновики — ещё не в работе, отгружать по ним нечего
    if invoice_no is not None:
        q = q.filter(ProductionOrderLine.invoice_no == invoice_no)
    rows = q.all()
    ol_ids = [ol.id for ol, _ in rows]
    totals = totals_by_order_line(db, ol_ids)
    by_site: dict[int, dict[str, float]] = defaultdict(dict)
    for b in balances(db, order_line_ids=ol_ids):
        if b.qty > 0:
            by_site[b.order_line_id][str(b.site_id or 0)] = b.qty
    items = {i.id: i.name for i in db.query(Item).filter(Item.id.in_({ol.item_id for ol, _ in rows}))} if rows else {}
    out: dict[str, list[InvoiceLine]] = defaultdict(list)
    for ol, o in rows:
        t = totals.get(ol.id, {"received": 0.0, "shipped": 0.0, "on_stock": 0.0})
        out[ol.invoice_no].append(
            InvoiceLine(
                order_line_id=ol.id, order_id=o.id, order_name=o.name, item_id=ol.item_id, item_name=items.get(ol.item_id, ""),
                ordered=float(ol.quantity), received=t["received"], shipped=t["shipped"], on_stock=t["on_stock"], by_site=by_site.get(ol.id, {}),
            )
        )
    return out


def _summary(inv: str, lines: list[InvoiceLine]) -> InvoiceSummary:
    return InvoiceSummary(
        invoice_no=inv, orders=sorted({ln.order_name for ln in lines}), ordered=sum(ln.ordered for ln in lines),
        received=sum(ln.received for ln in lines), shipped=sum(ln.shipped for ln in lines), on_stock=sum(ln.on_stock for ln in lines),
        lines=sorted(lines, key=lambda x: x.item_name),
    )


@router.get("/invoices", response_model=list[InvoiceSummary])
def invoices(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[InvoiceSummary]:
    """Счета 1С из строк заказов: заказано / упаковано / отгружено / на складе."""
    out = [_summary(inv, lines) for inv, lines in _invoice_lines(db).items()]
    # сначала — где есть что отгрузить, потом недоотгруженные, потом закрытые
    return sorted(out, key=lambda s: (s.on_stock <= 0, s.shipped >= s.ordered, s.invoice_no))


# ---------- отгрузка ----------
class ShipLineIn(BaseModel):
    order_line_id: int
    site_id: int | None = None
    qty: float = Field(gt=0)


class ShipmentIn(BaseModel):
    invoice_no: str
    customer: str | None = Field(default=None, max_length=255)
    note: str | None = Field(default=None, max_length=255)
    lines: list[ShipLineIn]


class ShipmentLineOut(BaseModel):
    order_line_id: int | None = None
    item_name: str
    qty: float
    order_name: str | None
    site_name: str | None
    # вернул клиент по этой строке заказа в этой отгрузке
    returned: float = 0


class ShipmentOut(BaseModel):
    id: int
    invoice_no: str | None
    customer: str | None
    note: str | None
    status: str
    created_at: datetime
    created_by_name: str | None
    cancelled_at: datetime | None
    lines: list[ShipmentLineOut]
    total: float
    returned: float = 0


def _shipment_out(db: Session, sh: FgShipment) -> ShipmentOut:
    sites, users = _names(db)
    mv = db.query(FgMove).filter(FgMove.shipment_id == sh.id, FgMove.kind == FG_SHIPMENT).all()
    items = {i.id: i.name for i in db.query(Item).filter(Item.id.in_({m.item_id for m in mv}))} if mv else {}
    ols = {ol.id: ol.order_id for ol in db.query(ProductionOrderLine).filter(ProductionOrderLine.id.in_({m.order_line_id for m in mv if m.order_line_id}))} if mv else {}
    onames = {o.id: o.name for o in db.query(ProductionOrder).filter(ProductionOrder.id.in_(set(ols.values())))} if ols else {}
    returned = _returned_by_line(db, sh.id)
    lines = [
        ShipmentLineOut(
            order_line_id=m.order_line_id, item_name=items.get(m.item_id, ""), qty=-float(m.qty),
            order_name=onames.get(ols.get(m.order_line_id)), site_name=sites.get(m.site_id), returned=returned.get(m.order_line_id, 0.0),
        )
        for m in mv
    ]
    return ShipmentOut(
        id=sh.id, invoice_no=sh.invoice_no, customer=sh.customer, note=sh.note, status=sh.status, created_at=sh.created_at,
        created_by_name=users.get(sh.created_by), cancelled_at=sh.cancelled_at, lines=lines, total=sum(ln.qty for ln in lines),
        returned=round(sum(returned.values()), 2),
    )


def _returned_by_line(db: Session, shipment_id: int) -> dict[int | None, float]:
    out: dict[int | None, float] = defaultdict(float)
    for m in db.query(FgMove).filter(FgMove.shipment_id == shipment_id, FgMove.kind == FG_RETURN):
        out[m.order_line_id] += float(m.qty)
    return {k: round(v, 2) for k, v in out.items()}


@router.post("/shipments", response_model=ShipmentOut, status_code=status.HTTP_201_CREATED)
def ship(payload: ShipmentIn, db: Session = Depends(get_db), user: User = Depends(ship_fg)) -> ShipmentOut:
    """Отгрузить по счёту: со склада площадки, под строку заказа. Больше, чем
    лежит, — нельзя (одна транзакция на всю отгрузку)."""
    if not payload.lines:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Нечего отгружать")
    sh = FgShipment(invoice_no=payload.invoice_no, customer=payload.customer, note=payload.note, status=SHIP_DONE, created_by=user.id)
    db.add(sh)
    db.flush()
    stock = {(b.order_line_id, b.site_id): b.qty for b in balances(db, order_line_ids=[ln.order_line_id for ln in payload.lines])}
    for ln in payload.lines:
        ol = db.get(ProductionOrderLine, ln.order_line_id)
        if ol is None or (ol.invoice_no or "") != payload.invoice_no:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Строка не из этого счёта")
        have = stock.get((ln.order_line_id, ln.site_id), 0.0)
        if ln.qty > have + 1e-9:
            item = db.get(Item, ol.item_id)
            raise HTTPException(status.HTTP_409_CONFLICT, f"«{item.name if item else ol.item_id}»: на складе {have:g}, отгрузить {ln.qty:g} нельзя")
        stock[(ln.order_line_id, ln.site_id)] = have - ln.qty
        db.add(
            FgMove(
                item_id=ol.item_id, qty=-ln.qty, kind=FG_SHIPMENT, site_id=ln.site_id, order_line_id=ol.id, invoice_no=ol.invoice_no,
                shipment_id=sh.id, note=payload.note, user_id=user.id,
            )
        )
    db.commit()
    return _shipment_out(db, sh)


@router.get("/shipments", response_model=list[ShipmentOut])
def list_shipments(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[ShipmentOut]:
    return [_shipment_out(db, sh) for sh in db.query(FgShipment).order_by(FgShipment.created_at.desc()).limit(300)]


@router.post("/shipments/{shipment_id}/cancel", response_model=ShipmentOut)
def cancel_shipment(shipment_id: int, db: Session = Depends(get_db), user: User = Depends(ship_fg)) -> ShipmentOut:
    """Отменить отгрузку целиком — двери возвращаются на склад (запись
    «отгрузка отменена», история не переписывается)."""
    sh = db.get(FgShipment, shipment_id)
    if sh is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Отгрузка не найдена")
    if sh.status == SHIP_CANCELLED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Отгрузка уже отменена")
    # то, что клиент уже вернул, на склад второй раз не возвращаем
    returned = dict(_returned_by_line(db, sh.id))
    for m in db.query(FgMove).filter(FgMove.shipment_id == sh.id, FgMove.kind == FG_SHIPMENT).all():
        qty = -float(m.qty)
        back = min(qty, returned.get(m.order_line_id, 0.0))
        returned[m.order_line_id] = returned.get(m.order_line_id, 0.0) - back
        if qty - back <= 1e-9:
            continue
        db.add(
            FgMove(
                item_id=m.item_id, qty=qty - back, kind=FG_UNSHIP, site_id=m.site_id, order_line_id=m.order_line_id,
                invoice_no=m.invoice_no, shipment_id=sh.id, note=f"Отмена отгрузки №{sh.id}", user_id=user.id,
            )
        )
    sh.status = SHIP_CANCELLED
    sh.cancelled_by = user.id
    sh.cancelled_at = datetime.now(timezone.utc)
    db.commit()
    return _shipment_out(db, sh)


# ---------- возврат от клиента ----------
class ReturnLineIn(BaseModel):
    order_line_id: int
    qty: float = Field(gt=0)


class ReturnIn(BaseModel):
    site_id: int | None = None  # куда вернули (по умолчанию — основной склад)
    reason: str = Field(min_length=1, max_length=200)
    lines: list[ReturnLineIn]


@router.post("/shipments/{shipment_id}/return", response_model=ShipmentOut)
def return_from_customer(shipment_id: int, payload: ReturnIn, db: Session = Depends(get_db), user: User = Depends(ship_fg)) -> ShipmentOut:
    """Возврат от клиента (06.10): часть отгруженного вернулась — снова на
    склад площадки под тот же заказ и счёт, с причиной. Больше, чем
    отгружено этой отгрузкой за вычетом прошлых возвратов, — нельзя."""
    sh = db.get(FgShipment, shipment_id)
    if sh is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Отгрузка не найдена")
    if sh.status == SHIP_CANCELLED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Отгрузка отменена — возвращать нечего")
    if not payload.lines:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите, что вернули")
    site_id = payload.site_id
    if site_id is None:
        main = db.query(Site).filter(Site.is_fg_main.is_(True)).first()
        site_id = main.id if main else None
    shipped: dict[int | None, tuple[float, FgMove]] = {}
    for m in db.query(FgMove).filter(FgMove.shipment_id == sh.id, FgMove.kind == FG_SHIPMENT):
        prev = shipped.get(m.order_line_id)
        shipped[m.order_line_id] = ((prev[0] if prev else 0.0) - float(m.qty), m)
    returned = _returned_by_line(db, sh.id)
    for ln in payload.lines:
        if ln.order_line_id not in shipped:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Строки нет в этой отгрузке")
        total, m = shipped[ln.order_line_id]
        left = total - returned.get(ln.order_line_id, 0.0)
        if ln.qty > left + 1e-9:
            item = db.get(Item, m.item_id)
            raise HTTPException(status.HTTP_409_CONFLICT, f"«{item.name if item else m.item_id}»: отгружено {total:g}, уже вернули {total - left:g} — вернуть {ln.qty:g} нельзя")
        returned[ln.order_line_id] = returned.get(ln.order_line_id, 0.0) + ln.qty
        db.add(
            FgMove(
                item_id=m.item_id, qty=ln.qty, kind=FG_RETURN, site_id=site_id, order_line_id=ln.order_line_id,
                invoice_no=m.invoice_no, shipment_id=sh.id, note=f"Возврат от клиента: {payload.reason.strip()}", user_id=user.id,
            )
        )
    db.commit()
    return _shipment_out(db, sh)


# ---------- перемещение между площадками ----------
class TransferIn(BaseModel):
    item_id: int
    order_line_id: int | None = None
    from_site_id: int | None = None
    to_site_id: int
    qty: float = Field(gt=0)
    note: str | None = Field(default=None, max_length=200)


@router.post("/transfer", response_model=list[StockRow])
def transfer(payload: TransferIn, db: Session = Depends(get_db), user: User = Depends(ship_fg)) -> list[StockRow]:
    """Перевезти готовые двери с площадки на площадку (06.10: с Фабрики —
    перевалки — на Северный): две записи «перемещение», заказ и счёт те же."""
    if payload.to_site_id == payload.from_site_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Площадки откуда и куда совпадают")
    to_site = db.get(Site, payload.to_site_id)
    if to_site is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Площадка не найдена")
    have = sum(
        b.qty
        for b in balances(db, item_ids=[payload.item_id])
        if b.site_id == payload.from_site_id and b.order_line_id == payload.order_line_id
    )
    if payload.qty > have + 1e-9:
        raise HTTPException(status.HTTP_409_CONFLICT, f"На площадке {have:g} шт — перевезти {payload.qty:g} нельзя")
    ol = db.get(ProductionOrderLine, payload.order_line_id) if payload.order_line_id else None
    sites, _ = _names(db)
    note = payload.note or f"{sites.get(payload.from_site_id, 'без площадки')} → {to_site.name}"
    for site_id, qty in ((payload.from_site_id, -payload.qty), (payload.to_site_id, payload.qty)):
        db.add(
            FgMove(
                item_id=payload.item_id, qty=qty, kind=FG_TRANSFER, site_id=site_id, order_line_id=payload.order_line_id,
                invoice_no=ol.invoice_no if ol else None, note=note, user_id=user.id,
            )
        )
    db.commit()
    return stock(db, user)


# ---------- корректировка ----------
class AdjustIn(BaseModel):
    item_id: int
    site_id: int | None = None
    order_line_id: int | None = None
    actual_qty: float = Field(ge=0)
    reason: str = Field(min_length=1, max_length=200)


@router.post("/adjust", response_model=list[StockRow])
def adjust(payload: AdjustIn, db: Session = Depends(get_db), user: User = Depends(ship_fg)) -> list[StockRow]:
    """Пересчёт или оприходование упакованного до запуска склада: факт на
    складе площадки под строку заказа (или без заказа) — разница записью."""
    if db.get(Item, payload.item_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    ol = db.get(ProductionOrderLine, payload.order_line_id) if payload.order_line_id else None
    if payload.order_line_id and (ol is None or ol.item_id != payload.item_id):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Строка заказа другой позиции")
    cur = sum(
        b.qty for b in balances(db, item_ids=[payload.item_id]) if b.site_id == payload.site_id and b.order_line_id == payload.order_line_id
    )
    diff = round(payload.actual_qty - cur, 2)
    if diff:
        db.add(
            FgMove(
                item_id=payload.item_id, qty=diff, kind=FG_ADJUST, site_id=payload.site_id, order_line_id=payload.order_line_id,
                invoice_no=ol.invoice_no if ol else None, note=payload.reason, user_id=user.id,
            )
        )
        db.commit()
    return stock(db, user)
