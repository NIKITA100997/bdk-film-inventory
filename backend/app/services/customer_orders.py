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
    line_received: dict[int, float] = field(default_factory=dict)  # принято на склад ГП по строке


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
    p.line_received = dict(rec_by_line)
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


def build_production_order(
    db: Session, orders: list[CustomerOrder], user_id: int, name: str | None = None, line_ids: set[int] | None = None
) -> ProductionOrder:
    """Запуск из принятых заказов клиентов: черновик заказа на производство,
    строка на остаток каждой позиции; сроки — по самому раннему заказу,
    приоритет — по самому срочному. line_ids (20.10) — только эти строки
    заказов: погонаж и двери одного счёта запускаются отдельно, в разные дни."""
    from datetime import date as _date

    rows = [(co, ln, left) for co in orders for ln, left in remaining_lines(db, co) if line_ids is None or ln.id in line_ids]
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


def find_by_invoice(db: Session, invoice_no: str | None, exclude_id: int | None = None) -> CustomerOrder | None:
    """Заказ по тому же счёту (20.10): «1029-ЛД(М)» = «№1029-лд»."""
    from app.services.invoice_1c import invoice_key

    key = invoice_key(invoice_no)
    if not key:
        return None
    q = db.query(CustomerOrder).filter(CustomerOrder.invoice_key == key)
    if exclude_id:
        q = q.filter(CustomerOrder.id != exclude_id)
    return q.first()


def apply_actual_ship_date(db: Session, co: CustomerOrder, new: date | None, user_id: int, comment: str) -> bool:
    """Дата отгрузки от менеджера — актуальная (20.10): совпал счёт с уже
    заведённым заказом — его дата сама становится новой, с записью в
    истории дат. Не принятый — «по» вилки; принятый — и обещанная отгрузка
    (готовность не позже неё), сделка и незакрытые запуски только этого
    заказа — следом. Возвращает, поменялось ли что-то."""
    from app.models.production_orders import OrderDateChange
    from app.services import bitrix_deals as deals
    from app.services.weekly_plan import note_change

    if new is None:
        return False
    changed = False

    def log(field: str, old, val) -> None:
        db.add(OrderDateChange(customer_order_id=co.id, field=field, old_date=old, new_date=val, reason="manager",
                               comment=comment, user_id=user_id))

    if co.ship_to != new:
        log("ship_to", co.ship_to, new)
        co.ship_to, changed = new, True
        if co.ship_from and co.ship_from > new:
            co.ship_from = None
    if co.status == CO_ACCEPTED and co.ship_date != new:
        old = co.ship_date
        log("ship", old, new)
        co.ship_date, changed = new, True
        if co.promised_ready and co.promised_ready > new:
            log("ready", co.promised_ready, new)
            co.promised_ready = new
        note_change(db, co, old, new, f"дата отгрузки уточнена менеджером: {comment}", user_id)
        deals.push_ship_date(db, co)
        deals.comment(db, co, f"Дата отгрузки уточнена: {new:%d.%m.%Y} ({comment})")
        # запуски только этого заказа — на ту же дату
        db.flush()
        line_ids = {ln.id for ln in co.lines if ln.id}
        po_ids = {
            i for (i,) in db.query(ProductionOrderLine.order_id).filter(ProductionOrderLine.customer_order_line_id.in_(line_ids or {-1}))
        }
        for po in db.query(ProductionOrder).filter(ProductionOrder.id.in_(po_ids or {-1}), ProductionOrder.status != ORDER_CLOSED):
            if all(pl.customer_order_line_id in line_ids for pl in po.lines) and po.ship_date != new:
                db.add(OrderDateChange(order_id=po.id, field="ship", old_date=po.ship_date, new_date=new, reason="manager",
                                       comment=f"заказ клиента {co.invoice_no}: {comment}", user_id=user_id))
                po.ship_date = new
    return changed


def line_decor(note: str | None, source: str | None) -> str:
    """Декор строки (погонаж): из примечания «декор: …» или последних скобок
    исходного текста; без регистра и «ё»."""
    import re

    from app.services.schedule_import import decor_of

    m = re.search(r"декор:\s*([^,]+)", note or "")
    d = m.group(1) if m else (decor_of(source or "") or "")
    return " ".join(d.lower().replace("ё", "е").split())


def merge_lines(db: Session, co: CustomerOrder, lines: list[tuple[int, float, str | None, str | None]]) -> tuple[int, int]:
    """Повторная загрузка счёта (20.10): позиции, которых нет, — добавить;
    те, что есть, — количество по счёту, но не меньше запущенного. Строки
    заказа, которых в счёте нет, не трогаем (их могли добавить вручную).
    lines — (item_id, кол-во, примечание, исходный текст). Возвращает
    (добавлено, изменено)."""
    launched = progress(db, co).line_launched if co.id else {}
    # позиция + декор: у погонажа одна позиция в разных декорах — разные строки
    by_item = {(ln.item_id, line_decor(ln.note, ln.source_text)): ln for ln in co.lines}
    added = changed = 0
    n = max((ln.sort_order for ln in co.lines), default=0)
    for item_id, qty, note, src in lines:
        key = (item_id, line_decor(note, src))
        ex = by_item.get(key)
        if ex is None:
            n += 1
            ln = CustomerOrderLine(item_id=item_id, quantity=qty, note=note, source_text=src, sort_order=n)
            co.lines.append(ln)
            by_item[key] = ln
            added += 1
        elif float(ex.quantity) != qty:
            ex.quantity = max(qty, launched.get(ex.id, 0.0))
            changed += 1
    return added, changed


READY_NO_LAUNCH = "Готово без запуска"


def mark_ready_without_launch(db: Session, co: CustomerOrder, line: CustomerOrderLine, qty: float, site_id: int | None, user_id: int):
    """«Готово…» по строке заказа клиента без запуска (20.10): царговые и
    всё, что делают вне программы, — начальник производства отмечает
    готовое сам. Под капотом — лёгкий заказ на производство «Готово без
    запуска» (без заданий) со строкой на это количество и приход на склад
    ГП по ней: дальше отгрузка, ход заказа и стадия сделки — как у всех."""
    from datetime import datetime, timezone

    from app.models.finished_goods import FG_RECEIPT, FgMove

    if co.status != CO_ACCEPTED:
        raise ValueError("Отметить готовность можно у принятого заказа")
    if line.order_id != co.id:
        raise ValueError("Строка не из этого заказа")
    left = round(float(line.quantity) - progress(db, co).line_launched.get(line.id, 0.0), 2)
    if qty <= 0 or qty > left + 1e-9:
        raise ValueError(f"Можно отметить не больше {left:g} шт — остальное уже готово или в запуске" if left > 0 else "Строка уже готова или запущена целиком")
    name = f"{READY_NO_LAUNCH}: счёт {co.invoice_no}"[:255]
    line_ids = [ln.id for ln in co.lines]
    po = (
        db.query(ProductionOrder)
        .join(ProductionOrderLine, ProductionOrderLine.order_id == ProductionOrder.id)
        .filter(ProductionOrder.name == name, ProductionOrderLine.customer_order_line_id.in_(line_ids or [-1]))
        .first()
    )
    if po is None:
        po = ProductionOrder(
            name=name, status=ORDER_RELEASED, released_at=datetime.now(timezone.utc), created_by=user_id,
            ship_date=co.ship_date, promised_ready=co.promised_ready, customer=co.customer, priority=co.priority or 0,
            note="готовность отмечена в заказе клиента, без заданий участкам",
        )
        db.add(po)
        db.flush()
    elif po.status != ORDER_RELEASED:
        po.status = ORDER_RELEASED
    pol = ProductionOrderLine(
        item_id=line.item_id, quantity=qty, note=line.note, invoice_no=co.invoice_no, source_text=line.source_text,
        sort_order=len(po.lines) + 1, customer_order_line_id=line.id,
    )
    po.lines.append(pol)
    db.flush()
    move = FgMove(item_id=line.item_id, qty=qty, kind=FG_RECEIPT, site_id=site_id, order_line_id=pol.id,
                  invoice_no=co.invoice_no, user_id=user_id, note=f"{READY_NO_LAUNCH}: счёт {co.invoice_no}")
    db.add(move)
    db.flush()
    return move
