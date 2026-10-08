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


# ---------- шаг 1в: себестоимость отчёта и партии п/ф ----------
#
# Отчёт мастера получает себестоимость при сохранении (before_commit — к
# этому моменту в транзакции уже записаны его расход материалов и списание
# комплектующих): плёнка (метры отчёта × ширина рулона × цена м²) +
# материалы (расход по строке в этой транзакции) + комплектующие п/ф
# (списанные партии × их себестоимость штуки) + работа (сдельно: годные ×
# расценка операции или участка; за смену — в отчёт по участкам, не в
# партию). Стоимость отчёта ÷ годные прибавляется к себестоимости штуки
# партии, которую отчёт сделал или перевёл на этап. Расход нескольких
# отчётов одной строки в одной транзакции делится по штукам.

_SKIP_KINDS = {"close"}  # «сделано полностью» без отчёта — производства нет


def note_component_cost(db: Session, task_line_id: int | None, qty: float, unit_cost: float | None) -> None:
    """Списание комплектующего п/ф в производство (consume_components_at_operation)
    — запомнить его стоимость для отчёта этой строки."""
    if task_line_id is None:
        return
    acc = db.info.setdefault("lc_components", {})
    a = acc.setdefault(task_line_id, [0.0, 0.0])  # [₽, шт без себестоимости]
    if unit_cost is None:
        a[1] += float(qty)
    else:
        a[0] += float(qty) * float(unit_cost)


@event.listens_for(Session, "after_flush")
def _collect(session: Session, flush_context) -> None:
    from app.models.finished_goods import FgMove
    from app.models.items import MaterialMove
    from app.models.part_units import PartUnitEvent
    from app.models.production import ProductionTaskLineReport

    info = session.info
    for o in session.new:
        if isinstance(o, FgMove):
            info.setdefault("lc_fg", set()).add(o.id)
        elif isinstance(o, ProductionTaskLineReport):
            info.setdefault("lc_reports", set()).add(o.id)
        elif isinstance(o, MaterialMove) and o.task_line_id is not None:
            info.setdefault("lc_moves", set()).add(o.id)
        elif isinstance(o, PartUnitEvent):
            info.setdefault("lc_pf_events", set()).add(o.id)


def _clear(session: Session) -> None:
    for k in ("lc_reports", "lc_moves", "lc_pf_events", "lc_components", "lc_fg"):
        session.info.pop(k, None)


@event.listens_for(Session, "after_rollback")
def _after_rollback(session: Session) -> None:
    _clear(session)


def _report_rate(stage, area) -> float | None:
    if stage is not None and stage.piece_rate is not None:
        return float(stage.piece_rate)
    if area is not None and area.pay_mode == "piece" and area.piece_rate is not None:
        return float(area.piece_rate)
    return None


@event.listens_for(Session, "before_commit")
def _cost_reports(session: Session) -> None:
    info = session.info
    if not any(info.get(k) for k in ("lc_reports", "lc_pf_events", "lc_fg")):
        _clear(session)
        return
    from app.models.areas import Area
    from app.models.dictionaries import PartStage
    from app.models.items import MaterialMove
    from app.models.part_units import PartUnit, PartUnitEvent
    from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
    from app.services.production import report_film_m

    with session.no_autoflush:
        reports = [r for r in (session.get(ProductionTaskLineReport, i) for i in info.get("lc_reports", ())) if r is not None]
        reports = [r for r in reports if r.kind not in _SKIP_KINDS and r.cost_rub is None]
        moves = [m for m in (session.get(MaterialMove, i) for i in info.get("lc_moves", ())) if m is not None]
        comps = info.get("lc_components", {})
        by_line: dict[int, list] = {}
        for r in reports:
            by_line.setdefault(r.task_line_id, []).append(r)
        mat_by_line: dict[int, list[float]] = {}
        for m in moves:
            if m.kind != "consumption":
                continue
            a = mat_by_line.setdefault(m.task_line_id, [0.0, 0])
            if m.amount_rub is None:
                a[1] += 1
            else:
                a[0] += -float(m.amount_rub)
        for line_id, reps in by_line.items():
            line = session.get(ProductionTaskLine, line_id)
            if line is None:
                continue
            task = session.get(ProductionTask, line.task_id)
            area = session.get(Area, task.area) if task else None
            stage = session.get(PartStage, line.part_stage_id) if line.part_stage_id else None
            rate = _report_rate(stage, area)
            weight = {r.id: float(r.good_pieces) + float(r.defect_pieces or 0) for r in reps}
            total_w = sum(weight.values())
            mat_rub, mat_unpriced = mat_by_line.get(line_id, [0.0, 0])
            comp_rub, comp_unpriced = comps.get(line_id, [0.0, 0.0])
            for r in reps:
                share = weight[r.id] / total_w if total_w > 0 else 1.0 / len(reps)
                parts: dict = {
                    "film": 0.0, "materials": round(mat_rub * share, 2), "components": round(comp_rub * share, 2), "labor": 0.0,
                }
                missing = []
                if mat_unpriced:
                    missing.append("материалы без цены")
                if comp_unpriced:
                    missing.append("комплектующие без себестоимости")
                if r.material_unit_id:
                    unit = session.get(MaterialUnit, r.material_unit_id)
                    meters = report_film_m(
                        float(r.good_pieces), float(r.defect_pieces or 0), float(line.length_m),
                        float(r.film_used_m) if r.film_used_m is not None else None,
                    )
                    if unit is not None and unit.price_per_m2 is not None:
                        parts["film"] = round(meters * float(unit.width_mm) / 1000 * float(unit.price_per_m2), 2)
                    elif meters:
                        missing.append("плёнка без цены")
                if r.kind is None and float(r.good_pieces) > 0:
                    if rate is not None:
                        parts["labor"] = round(float(r.good_pieces) * rate, 2)
                    elif area is not None and area.pay_mode != "shift":
                        missing.append("нет расценки")
                if missing:
                    parts["missing"] = missing
                r.cost_rub = round(parts["film"] + parts["materials"] + parts["components"] + parts["labor"], 2)
                r.cost_parts = parts
                good = float(r.good_pieces)
                if r.part_unit_id and good > 0 and r.cost_rub:
                    lot = session.get(PartUnit, r.part_unit_id)
                    if lot is not None:
                        lot.unit_cost_rub = round(float(lot.unit_cost_rub or 0) + r.cost_rub / good, 4)
        # суммы событий п/ф — по себестоимости штуки партии
        for i in info.get("lc_pf_events", ()):
            ev = session.get(PartUnitEvent, i)
            if ev is None or ev.amount_rub is not None or not ev.quantity_delta:
                continue
            lot = session.get(PartUnit, ev.part_unit_id)
            if lot is not None and lot.unit_cost_rub is not None:
                ev.amount_rub = round(float(ev.quantity_delta) * float(lot.unit_cost_rub), 2)
        # готовые изделия — после отчётов: приход берёт их себестоимость
        if info.get("lc_fg"):
            session.flush()
            stamp_fg_moves(session, set(info["lc_fg"]))
    _clear(session)
    session.flush()


@event.listens_for(Session, "before_flush")
def _inherit_pf_cost(session: Session, flush_context, instances) -> None:
    """Кусок партии п/ф (дробление при переходе этапа, расходе) — та же
    себестоимость штуки, что у родителя."""
    from app.models.part_units import PartUnit

    for o in session.new:
        if isinstance(o, PartUnit) and o.unit_cost_rub is None and o.parent_id:
            with session.no_autoflush:
                parent = session.get(PartUnit, o.parent_id)
            if parent is not None:
                o.unit_cost_rub = parent.unit_cost_rub


# ---------- шаг 1г: себестоимость готового изделия ----------
#
# Дверь — без партий, на строке заказа. Приход на склад (упаковка,
# «Закрыть: всё сделано») — по себестоимости штуки строки заказа: по каждой
# операции её маршрута стоимость отчётов ÷ годные, сложенные по операциям
# (так верно, даже если склеено больше, чем упаковано). Отгрузка,
# перемещение, возврат, корректировка — по средней себестоимости остатка
# позиции (сумма ÷ количество по движениям с суммой).


def order_line_unit_cost(db: Session, order_line_id: int) -> float | None:
    from sqlalchemy import func

    from app.models.dictionaries import PartStage
    from app.models.production import ProductionTaskLine, ProductionTaskLineReport
    from app.models.production_orders import ProductionOrderLine

    ol = db.get(ProductionOrderLine, order_line_id)
    if ol is None:
        return None
    # только операции самой позиции заказа: строки п/ф под эту строку (каркас,
    # панели) уже вошли через списание комплектующих — иначе двойной счёт
    rows = (
        db.query(
            ProductionTaskLine.part_stage_id,
            func.sum(ProductionTaskLineReport.cost_rub),
            func.sum(ProductionTaskLineReport.good_pieces),
        )
        .join(ProductionTaskLine, ProductionTaskLine.id == ProductionTaskLineReport.task_line_id)
        .join(PartStage, PartStage.id == ProductionTaskLine.part_stage_id)
        .filter(
            ProductionTaskLine.order_line_id == order_line_id, PartStage.item_id == ol.item_id,
            ProductionTaskLineReport.cost_rub.isnot(None),
        )
        .group_by(ProductionTaskLine.part_stage_id)
        .all()
    )
    total = 0.0
    found = False
    for _stage, cost, good in rows:
        if good and float(good) > 0 and cost is not None:
            total += float(cost) / float(good)
            found = True
    return round(total, 4) if found else None


def fg_avg_cost(db: Session, item_id: int, exclude_ids: set[int]) -> float | None:
    from sqlalchemy import func

    from app.models.finished_goods import FgMove

    q = db.query(func.sum(FgMove.amount_rub), func.sum(FgMove.qty)).filter(
        FgMove.item_id == item_id, FgMove.amount_rub.isnot(None)
    )
    if exclude_ids:
        q = q.filter(FgMove.id.notin_(exclude_ids))
    amount, qty = q.one()
    if amount is None or qty is None or float(qty) <= 1e-9 or float(amount) < 0:
        return None
    return round(float(amount) / float(qty), 4)


def stamp_fg_moves(session: Session, ids: set[int]) -> None:
    from app.models.finished_goods import FgMove

    moves = [m for m in (session.get(FgMove, i) for i in ids) if m is not None and m.amount_rub is None]
    # сначала приходы — по ним считается средняя для расходов той же транзакции
    moves.sort(key=lambda m: (float(m.qty) < 0, m.id))
    done: set[int] = set()
    for m in moves:
        unit = None
        if float(m.qty) > 0 and m.order_line_id and m.kind == "receipt":
            unit = order_line_unit_cost(session, m.order_line_id)
        if unit is None:
            unit = fg_avg_cost(session, m.item_id, {x.id for x in moves if x.id not in done})
            if unit is None and float(m.qty) > 0 and m.order_line_id:
                unit = order_line_unit_cost(session, m.order_line_id)
        if unit is not None:
            m.amount_rub = round(float(m.qty) * unit, 2)
        done.add(m.id)
