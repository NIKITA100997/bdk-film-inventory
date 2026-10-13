"""Заказы клиентов (13.10): стадия по запускам и складу ГП, сборка запуска,
пробный заказ на производство для оценок.

Стадия заказа клиента: черновик / отправлен / возвращён / отменён — как
поставил человек; после приёма — по фактам: не запущен → в производстве
(есть строки в запущенном заказе на производство) → готов (всё принято на
склад ГП) → отгружен частично → отгружен."""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy.orm import Session

from app.models.customer_orders import CO_ACCEPTED, CO_CANCELLED, CustomerOrder, CustomerOrderLine
from app.models.finished_goods import FG_RECEIPT, FgMove
from app.models.production_orders import ORDER_CLOSED, ORDER_DRAFT, ORDER_RELEASED, ProductionOrder, ProductionOrderLine

STAGE_LABEL = {
    "draft": "черновик",
    "submitted": "отправлен в производство",
    "returned": "возвращён",
    "accepted": "принят, не запущен",
    "assembled": "собран в запуск",
    "in_production": "в производстве",
    "ready": "готов",
    "shipped_part": "отгружен частично",
    "shipped": "отгружен",
    "cancelled": "отменён",
}


@dataclass
class Progress:
    qty: float = 0.0
    launched: float = 0.0  # в заказах на производство (черновик или запущен)
    in_work: float = 0.0  # в запущенных
    received: float = 0.0  # принято на склад ГП
    shipped: float = 0.0
    ready_fact: date | None = None
    last_shipped_at: date | None = None
    stage: str = "draft"
    production_orders: list[tuple[int, str, str]] = field(default_factory=list)  # (id, название, статус)
    line_launched: dict[int, float] = field(default_factory=dict)


def progress(db: Session, co: CustomerOrder) -> Progress:
    p = Progress(qty=sum(float(ln.quantity) for ln in co.lines))
    line_ids = [ln.id for ln in co.lines]
    links = (
        db.query(ProductionOrderLine, ProductionOrder)
        .join(ProductionOrder, ProductionOrder.id == ProductionOrderLine.order_id)
        .filter(ProductionOrderLine.customer_order_line_id.in_(line_ids or [-1]))
        .all()
    )
    pol_ids = []
    seen = {}
    for pol, po in links:
        p.launched += float(pol.quantity)
        p.line_launched[pol.customer_order_line_id] = p.line_launched.get(pol.customer_order_line_id, 0.0) + float(pol.quantity)
        if po.status in (ORDER_RELEASED, ORDER_CLOSED):
            p.in_work += float(pol.quantity)
        pol_ids.append(pol.id)
        seen[po.id] = (po.id, po.name, po.status)
    p.production_orders = list(seen.values())
    rec_by_line: dict[int, float] = defaultdict(float)
    last_rec = None
    if pol_ids:
        to_co = {pol.id: pol.customer_order_line_id for pol, _ in links}
        for m in db.query(FgMove).filter(FgMove.order_line_id.in_(pol_ids)):
            q = float(m.qty)
            if m.kind == FG_RECEIPT:
                rec_by_line[to_co[m.order_line_id]] += q
                last_rec = max(last_rec, m.occurred_at) if last_rec else m.occurred_at
            elif m.kind in ("shipment", "unship", "return"):
                p.shipped -= q
                if m.kind == "shipment":
                    d = m.occurred_at.astimezone().date()
                    p.last_shipped_at = max(p.last_shipped_at, d) if p.last_shipped_at else d
    p.received = sum(rec_by_line.values())
    full = bool(co.lines) and all(rec_by_line.get(ln.id, 0.0) >= float(ln.quantity) - 0.001 for ln in co.lines)
    p.ready_fact = co.ready_at or (last_rec.astimezone().date() if full and last_rec else None)
    if co.status == CO_CANCELLED:
        p.stage = "cancelled"
    elif co.status != CO_ACCEPTED:
        p.stage = co.status
    elif p.qty and p.shipped >= p.qty - 0.001:
        p.stage = "shipped"
    elif p.shipped > 0:
        p.stage = "shipped_part"
    elif full or co.ready_at:
        p.stage = "ready"
    elif p.in_work > 0:
        p.stage = "in_production"
    elif p.launched > 0:
        p.stage = "assembled"  # в черновике заказа на производство, ещё не запущен
    else:
        p.stage = "accepted"
    p.received, p.shipped = round(p.received, 2), round(p.shipped, 2)
    return p


def remaining_lines(db: Session, co: CustomerOrder) -> list[tuple[CustomerOrderLine, float]]:
    """Что из заказа ещё не попало ни в один заказ на производство."""
    pr = progress(db, co)
    out = []
    for ln in co.lines:
        left = round(float(ln.quantity) - pr.line_launched.get(ln.id, 0.0), 2)
        if left > 0:
            out.append((ln, left))
    return out


def build_production_order(db: Session, orders: list[CustomerOrder], user_id: int, name: str | None = None) -> ProductionOrder:
    """Запуск из принятых заказов клиентов: черновик заказа на производство,
    строка на остаток каждой позиции; сроки — по самому раннему заказу,
    приоритет — по самому срочному."""
    from datetime import date as _date

    rows = [(co, ln, left) for co in orders for ln, left in remaining_lines(db, co)]
    if not rows:
        raise ValueError("В выбранных заказах нет незапущенных позиций")
    invoices = ", ".join(dict.fromkeys(co.invoice_no for co in orders))
    ready = [co.promised_ready for co in orders if co.promised_ready]
    ships = [co.ship_date for co in orders if co.ship_date]
    froms = [co.ship_from or co.ship_to for co in orders if co.ship_from or co.ship_to]
    tos = [co.ship_to for co in orders if co.ship_to]
    po = ProductionOrder(
        name=(name or f"Запуск {_date.today():%d.%m}: {invoices}")[:255], status=ORDER_DRAFT, created_by=user_id,
        ship_date=min(ships) if ships else None, promised_ready=min(ready) if ready else None,
        ship_from=min(froms) if froms else None, ship_to=min(tos) if tos else None,
        priority=max((co.priority or 0) for co in orders),
        customer=orders[0].customer if len({co.customer for co in orders}) == 1 else None,
        # комментарии заказов клиентов — в комментарий запуска (печатается в шапке заданий, 13.10)
        note="; ".join(f"{co.invoice_no}: {co.note}" for co in orders if (co.note or "").strip())[:255] or None,
    )
    for i, (co, ln, left) in enumerate(rows, start=1):
        po.lines.append(ProductionOrderLine(
            item_id=ln.item_id, quantity=left, note=ln.note, invoice_no=co.invoice_no, source_text=ln.source_text,
            sort_order=i, customer_order_line_id=ln.id,
        ))
    db.add(po)
    db.flush()
    return po


def transient_production_order(db: Session, co: CustomerOrder, user_id: int) -> ProductionOrder | None:
    """Пробный заказ на производство из незапущенного остатка заказа клиента —
    только внутри точки сохранения с откатом (оценка срока, потребность,
    загрузка плана)."""
    try:
        po = build_production_order(db, [co], user_id, name=f"проба {co.invoice_no}")
    except ValueError:
        return None
    po.ship_date, po.promised_ready = co.ship_date, co.promised_ready
    db.flush()
    return po


def manager_ids_of_production_order(db: Session, po: ProductionOrder) -> set[int]:
    ids = {ln.customer_order_line_id for ln in po.lines if ln.customer_order_line_id}
    if not ids:
        return {po.created_by} if po.created_by else set()
    return {
        co.manager_id or co.created_by
        for co in db.query(CustomerOrder).join(CustomerOrderLine).filter(CustomerOrderLine.id.in_(ids))
    }
