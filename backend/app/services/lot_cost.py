"""Учёт по количеству и сумме (08.10.2026, шаг 1а — плёнка).

Рулон получает цену м² в рублях при рождении и хранит её:
  приход / излишек инвентаризации — цена позиции на дату прихода (1С, УПД,
      вручную — services/prices, по общему курсу), иначе последняя цена
      из заявок поставщику на эту плёнку (материал + цвет + толщина);
  кусок после резки — цена родителя.
Каждое движение (MaterialEvent) хранит сумму: Δм × ширина × цена м².

Материалы (шаг 1б, MaterialMove — без партий, остаток одним числом):
  приход — цена позиции на дату (её же пишет УПД прихода);
  расход, списание, инвентаризация — средняя цена остатка (сумма ÷
      количество по движениям с ценой); средней нет — цена позиции на дату.

Ставится одним обработчиком записи в базу (before_flush), а не в каждом
месте, где рождается рулон или пишется событие: приход, резка, излишек
инвентаризации и все будущие пути получают цену сами.

«Оценка» (estimate) — цена, взятая не на дату прихода: позже прихода (на
дату цены ещё не было) или проставленная задним числом
(scripts/backfill_lot_prices.py)."""

from datetime import date, datetime, timezone

from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.events import MaterialEvent
from app.models.units import MaterialUnit

SRC_PRICE = "price"
SRC_REQUEST = "request"
SRC_ESTIMATE = "estimate"
SOURCE_LABEL = {SRC_PRICE: "цена на дату прихода", SRC_REQUEST: "по заявке поставщику", SRC_ESTIMATE: "оценка"}


def film_price_at(db: Session, sku, at: date) -> tuple[float | None, str | None]:
    """Цена м² плёнки в рублях на дату и откуда: цена позиции на дату →
    последняя заявка поставщику до даты → ближайшая более поздняя цена
    позиции или заявки (оценка)."""
    from app.models.purchasing import PurchaseRequest
    from app.models.prices import ItemPrice
    from app.services.prices import film_rub_per_m2

    if sku is None:
        return None, None
    if sku.item_id:
        rub = film_rub_per_m2(db, sku.item_id, sku.native_width_mm, at)
        if rub is not None:
            return round(rub, 4), SRC_PRICE
    reqs = db.query(PurchaseRequest).filter(
        PurchaseRequest.material_id == sku.material_id,
        PurchaseRequest.color_id == sku.color_id,
        PurchaseRequest.thickness_id == sku.thickness_id,
        PurchaseRequest.price_per_m2.isnot(None),
    )
    end = datetime.combine(at, datetime.max.time()).replace(tzinfo=timezone.utc)
    before = reqs.filter(PurchaseRequest.created_at <= end).order_by(PurchaseRequest.created_at.desc()).first()
    if before is not None:
        return round(float(before.price_per_m2), 4), SRC_REQUEST
    # на дату цены не было — ближайшая более поздняя
    if sku.item_id:
        later = (
            db.query(ItemPrice).filter(ItemPrice.item_id == sku.item_id, ItemPrice.valid_from > at)
            .order_by(ItemPrice.valid_from.asc(), ItemPrice.id.asc()).first()
        )
        if later is not None:
            rub = film_rub_per_m2(db, sku.item_id, sku.native_width_mm, later.valid_from)
            if rub is not None:
                return round(rub, 4), SRC_ESTIMATE
    after = reqs.order_by(PurchaseRequest.created_at.asc()).first()
    if after is not None:
        return round(float(after.price_per_m2), 4), SRC_ESTIMATE
    return None, None


def event_amount(delta_m: float, width_mm: float, price_per_m2: float | None) -> float | None:
    if price_per_m2 is None:
        return None
    return round(float(delta_m) * float(width_mm) / 1000 * float(price_per_m2), 2)


def unit_value(unit: MaterialUnit) -> float | None:
    """Сколько рублей лежит в рулоне сейчас."""
    if unit.price_per_m2 is None:
        return None
    return round(float(unit.length_m) * float(unit.width_mm) / 1000 * float(unit.price_per_m2), 2)


def _birth_date(unit: MaterialUnit) -> date:
    c = unit.created_at
    if isinstance(c, datetime):
        return c.date()
    return date.today()


def material_list_price(db: Session, item, at: date) -> float | None:
    """Цена единицы материала в рублях на дату — если цена заведена в
    единице позиции (иначе пересчитывать не во что)."""
    from app.models.items import item_unit
    from app.services.prices import price_rub

    pr = price_rub(db, item.id, at)
    if pr is None or (pr.unit and pr.unit != item_unit(item)):
        return None
    return round(pr.rub, 4)


def material_avg_price(db: Session, item_id: int, exclude_id: int | None = None) -> float | None:
    """Средняя цена остатка материала: сумма ÷ количество по движениям с
    ценой (скользящая средняя)."""
    from sqlalchemy import func

    from app.models.items import MaterialMove

    q = db.query(func.sum(MaterialMove.amount_rub), func.sum(MaterialMove.qty)).filter(
        MaterialMove.item_id == item_id, MaterialMove.amount_rub.isnot(None)
    )
    if exclude_id is not None:
        q = q.filter(MaterialMove.id != exclude_id)
    amount, qty = q.one()
    if amount is None or qty is None or float(qty) <= 1e-9 or float(amount) < 0:
        return None
    return round(float(amount) / float(qty), 4)


def stamp_material_move(db: Session, move) -> None:
    from app.models.items import MOVE_RECEIPT, Item

    item = move.item if getattr(move, "item", None) is not None else db.get(Item, move.item_id)
    at = move.occurred_at.date() if isinstance(move.occurred_at, datetime) else date.today()
    if move.kind == MOVE_RECEIPT:
        price = material_list_price(db, item, at) or material_avg_price(db, item.id, move.id)
    else:
        price = material_avg_price(db, item.id, move.id) or material_list_price(db, item, at)
    if price is None:
        return
    move.price_rub = price
    move.amount_rub = round(float(move.qty) * price, 2)


@event.listens_for(Session, "before_flush")
def _stamp(session: Session, flush_context, instances) -> None:
    from app.models.items import MaterialMove

    new_units = [o for o in session.new if isinstance(o, MaterialUnit) and o.price_per_m2 is None]
    new_events = [o for o in session.new if isinstance(o, MaterialEvent) and o.amount_rub is None]
    new_moves = [o for o in session.new if isinstance(o, MaterialMove) and o.amount_rub is None]
    if not new_units and not new_events and not new_moves:
        return
    with session.no_autoflush:
        from app.models.dictionaries import MaterialSku

        for u in new_units:
            parent = u.parent or (session.get(MaterialUnit, u.parent_id) if u.parent_id else None)
            if parent is not None:
                u.price_per_m2, u.price_source = parent.price_per_m2, parent.price_source
                continue
            sku = u.material_sku or session.get(MaterialSku, u.material_sku_id)
            u.price_per_m2, u.price_source = film_price_at(session, sku, _birth_date(u))
        for e in new_events:
            unit = session.get(MaterialUnit, e.unit_id) if e.unit_id else None
            if unit is None or unit.price_per_m2 is None or e.quantity_delta_m is None or e.width_mm is None:
                continue
            e.amount_rub = event_amount(e.quantity_delta_m, e.width_mm, unit.price_per_m2)
        for mv in sorted(new_moves, key=lambda x: x.occurred_at or datetime.max):
            stamp_material_move(session, mv)
