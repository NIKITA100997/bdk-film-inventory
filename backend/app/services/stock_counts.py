"""Единая инвентаризация по месту (27.10, models/part_counts.py): лист из
всего, что по учёту лежит в месте, — плёнка по рулонам/штрипсам (метры),
п/ф по партиям (шт, services/part_counts.py), материалы и изделия по позиции.
Решения по расхождениям — теми же операциями, что и вне инвентаризации,
с номером пересчёта в журнале."""
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.events import EventType
from app.models.finished_goods import FG_ADJUST, FgMove
from app.models.items import MOVE_ADJUST, Item, ItemKind
from app.models.part_counts import (
    DECISION_ACCEPT,
    DECISION_WRITE_OFF,
    KIND_FG,
    KIND_FILM,
    KIND_MATERIAL,
    KIND_PF,
    PLACE_AREA,
    PLACE_FG,
    PLACE_MATERIALS,
    PLACE_WAREHOUSE,
    PartCountLine,
    PartCountSession,
)
from app.models.units import MaterialUnit, UnitStatus
from app.services import finished_goods, materials
from app.services import part_counts as pf
from app.services.events import record_event
from app.services.unified_stock import _film_consumed
from app.services.warehouses import filter_by_warehouse, rack_codes_for_warehouse

FILM_AT_WAREHOUSE = (UnitStatus.NA_KHRANENII, UnitStatus.PRINYAT)

# какие виды бывают в месте и с какими правами их считают
PLACE_KINDS: dict[str, list[tuple[str, tuple[str, ...]]]] = {
    PLACE_AREA: [(KIND_PF, ("part_units.count",)), (KIND_FILM, ("inventory.manage",))],
    PLACE_WAREHOUSE: [(KIND_FILM, ("inventory.manage",))],
    PLACE_MATERIALS: [(KIND_MATERIAL, ("units.receive", "materials.manage", "production_tasks.manage", "part_units.manage"))],
    PLACE_FG: [(KIND_FG, ("fg.ship",))],
}


def kinds_for(place_type: str, perms: set[str], superuser: bool) -> list[str]:
    return [k for k, need in PLACE_KINDS.get(place_type, []) if superuser or perms & set(need)]


def session_kinds(db: Session, s: PartCountSession) -> set[str]:
    return {k for (k,) in db.query(PartCountLine.kind).filter(PartCountLine.session_id == s.id).distinct()}


# ---------- плёнка ----------
def film_remaining(db: Session, units: list[MaterialUnit]) -> dict[int, float]:
    """Сколько метров физически осталось: у выданной участку — за вычетом
    отчитанного в производстве (как в остатках)."""
    consumed = _film_consumed(db, [u.id for u in units if u.status == UnitStatus.VYDAN_UCHASTKU])
    return {u.id: 0.0 if u.status == UnitStatus.SPISAN else max(0.0, float(u.length_m) - consumed.get(u.id, 0.0)) for u in units}


def film_at_place(db: Session, s: PartCountSession) -> list[MaterialUnit]:
    q = db.query(MaterialUnit)
    if s.place_type == PLACE_AREA:
        return q.filter(MaterialUnit.status == UnitStatus.VYDAN_UCHASTKU, MaterialUnit.area == s.area).all()
    if s.place_type == PLACE_WAREHOUSE:
        q = q.filter(MaterialUnit.status.in_(FILM_AT_WAREHOUSE))
        return filter_by_warehouse(q, MaterialUnit.location_code, db, int(s.place_ref)).all()
    return []


def film_is_here(db: Session, s: PartCountSession, unit: MaterialUnit) -> bool:
    if s.place_type == PLACE_AREA:
        return unit.status == UnitStatus.VYDAN_UCHASTKU and unit.area == s.area
    if s.place_type == PLACE_WAREHOUSE:
        codes = rack_codes_for_warehouse(db, int(s.place_ref))
        return unit.status in FILM_AT_WAREHOUSE and any((unit.location_code or "").startswith(f"{c}-") for c in codes)
    return False


# ---------- изделия ----------
def fg_balance(db: Session, item_id: int, site_id: int) -> float:
    return round(sum(b.qty for b in finished_goods.balances(db, item_ids=[item_id]) if b.site_id == site_id), 2)


# ---------- лист ----------
def build_lines(db: Session, s: PartCountSession, kinds: list[str]) -> int:
    kinds = [k for k in kinds if k in {pk for pk, _ in PLACE_KINDS.get(s.place_type, [])}]
    n = 0
    if KIND_PF in kinds and s.place_type == PLACE_AREA:
        n += pf.build_lines(db, s)
    if KIND_FILM in kinds:
        units = film_at_place(db, s)
        rem = film_remaining(db, units)
        for u in units:
            if rem[u.id] > 0:
                db.add(PartCountLine(session_id=s.id, kind=KIND_FILM, material_unit_id=u.id, expected_qty=round(rem[u.id], 3)))
                n += 1
    if KIND_MATERIAL in kinds:
        items = (
            db.query(Item).join(ItemKind, ItemKind.id == Item.kind_id)
            .filter(ItemKind.code == materials.KIND_MATERIAL, Item.is_active.is_(True)).all()
        )
        bal = materials.balances(db, [i.id for i in items])
        # с остатком; найденное без остатка — «сверх листа»
        for i in (i for i in items if abs(bal.get(i.id, 0.0)) > 1e-9):
            db.add(PartCountLine(session_id=s.id, kind=KIND_MATERIAL, item_id=i.id, expected_qty=round(bal.get(i.id, 0.0), 3)))
            n += 1
    if KIND_FG in kinds:
        site_id = int(s.place_ref)
        per_item: dict[int, float] = {}
        for b in finished_goods.balances(db):
            if b.site_id == site_id:
                per_item[b.item_id] = per_item.get(b.item_id, 0.0) + b.qty
        for item_id, q in per_item.items():
            if q > 0:
                db.add(PartCountLine(session_id=s.id, kind=KIND_FG, item_id=item_id, site_id=site_id, expected_qty=round(q, 2)))
                n += 1
    return n


def current_expected(db: Session, s: PartCountSession, line: PartCountLine) -> float:
    """«По учёту» сейчас — обновляется при вводе факта (между открытием и
    пересчётом могли отчитаться, выдать, отгрузить)."""
    if line.kind == KIND_PF:
        return pf.current_free(db, line)
    if line.kind == KIND_FILM:
        unit = db.get(MaterialUnit, line.material_unit_id)
        if unit is None or not film_is_here(db, s, unit):
            return 0.0
        return round(film_remaining(db, [unit])[unit.id], 3)
    if line.kind == KIND_MATERIAL:
        return round(materials.balances(db, [line.item_id]).get(line.item_id, 0.0), 3)
    if line.kind == KIND_FG:
        return fg_balance(db, line.item_id, line.site_id)
    return float(line.expected_qty)


# ---------- решения ----------
def _film_move_here(db: Session, s: PartCountSession, unit: MaterialUnit, user_id: int, note: str) -> None:
    from app.models.storage import Warehouse

    from_cell = unit.location_code
    if s.place_type == PLACE_AREA:
        unit.status, unit.area, unit.location_code = UnitStatus.VYDAN_UCHASTKU, s.area, None
        to_cell = None
    else:
        w = db.get(Warehouse, int(s.place_ref))
        unit.status, unit.area, unit.location_code = UnitStatus.NA_KHRANENII, None, w.default_cell if w else None
        to_cell = unit.location_code
    record_event(
        db, unit=unit, event_type=EventType.INVENTARIZATSIYA_PEREMESHCHENO, user_id=user_id,
        from_cell=from_cell, to_cell=to_cell, write_off_note=note,
    )


def _resolve_film(db: Session, s: PartCountSession, line: PartCountLine, decision: str, d: float, reason: str | None, note: str, user_id: int) -> None:
    unit = db.get(MaterialUnit, line.material_unit_id)
    old = float(unit.length_m)
    if decision == DECISION_WRITE_OFF:
        counted = float(line.counted_qty or 0)
        if counted <= 0:
            unit.status = UnitStatus.SPISAN
            unit.is_strip = True
            record_event(
                db, unit=unit, event_type=EventType.SPISANIE, user_id=user_id, quantity_delta_m=d, from_length=old,
                to_length=0, write_off_reason=reason, write_off_note=note,
            )
        else:
            unit.length_m = round(old + d, 3)
            record_event(
                db, unit=unit, event_type=EventType.SPISANIE, user_id=user_id, quantity_delta_m=d, from_length=old,
                to_length=float(unit.length_m), write_off_reason=reason, write_off_note=note,
            )
        return
    # оприходовать: найденный не на своём месте — переносим сюда; лишние метры — к длине
    if not film_is_here(db, s, unit):
        rem_before = film_remaining(db, [unit])[unit.id] if unit.status != UnitStatus.SPISAN else 0.0
        if unit.status == UnitStatus.SPISAN:
            unit.length_m = float(line.counted_qty)
        _film_move_here(db, s, unit, user_id, note)
        extra = round(float(line.counted_qty) - rem_before, 3) if rem_before else 0.0
        if extra > 0:
            unit.length_m = round(float(unit.length_m) + extra, 3)
        return
    unit.length_m = round(old + d, 3)
    record_event(
        db, unit=unit, event_type=EventType.INVENTARIZATSIYA_IZLISHEK, user_id=user_id, quantity_delta_m=d,
        from_length=old, to_length=float(unit.length_m), write_off_note=note,
    )


def _resolve_fg(db: Session, line: PartCountLine, d: float, user_id: int, note: str) -> None:
    """Излишек — на склад без заказа; недостача — сначала с остатка без
    заказа, потом с остатков под заказы (больший первым)."""
    if d > 0:
        db.add(FgMove(item_id=line.item_id, qty=d, kind=FG_ADJUST, site_id=line.site_id, note=note, user_id=user_id))
        return
    need = -d
    bals = [b for b in finished_goods.balances(db, item_ids=[line.item_id]) if b.site_id == line.site_id and b.qty > 0]
    bals.sort(key=lambda b: (b.order_line_id is not None, -b.qty))
    for b in bals:
        if need <= 0:
            break
        take = round(min(need, b.qty), 2)
        invoice = None
        if b.order_line_id:
            from app.models.production_orders import ProductionOrderLine

            ol = db.get(ProductionOrderLine, b.order_line_id)
            invoice = ol.invoice_no if ol else None
        db.add(FgMove(item_id=line.item_id, qty=-take, kind=FG_ADJUST, site_id=line.site_id, order_line_id=b.order_line_id,
                      invoice_no=invoice, note=note, user_id=user_id))
        need = round(need - take, 2)


def resolve_line(
    db: Session, *, session: PartCountSession, line: PartCountLine, decision: str, reason: str | None, note: str | None, user_id: int,
) -> int | None:
    """Решение по строке закрытого пересчёта любого вида. Возвращает партию
    п/ф, куда ушёл излишек (для п/ф), иначе None."""
    if line.kind == KIND_PF:
        return pf.resolve_line(db, session=session, line=line, decision=decision, reason=reason, note=note, user_id=user_id).part_unit_id
    exp, cnt = float(line.expected_qty), None if line.counted_qty is None else float(line.counted_qty)
    if decision not in pf.allowed_decisions(exp, cnt):
        raise ValueError("Для этой строки такое решение недоступно")
    d = pf.diff_of(exp, cnt)
    tag = f"Инвентаризация №{session.id}"
    full_note = f"{tag}{' — ' + note if note else ''}"
    if decision in (DECISION_WRITE_OFF, DECISION_ACCEPT):
        if line.kind == KIND_FILM:
            if decision == DECISION_WRITE_OFF and not reason:
                raise ValueError("Укажите причину списания")
            _resolve_film(db, session, line, decision, d, reason, full_note, user_id)
        elif line.kind == KIND_MATERIAL:
            item = db.get(Item, line.item_id)
            fact = max(0.0, materials.balances(db, [item.id]).get(item.id, 0.0) + d)
            materials.manual_move(db, item=item, kind=MOVE_ADJUST, qty=fact, user_id=user_id, doc=tag, note=full_note)
        elif line.kind == KIND_FG:
            _resolve_fg(db, line, d, user_id, full_note)
    line.decision = decision
    line.reason = reason if decision == DECISION_WRITE_OFF else None
    line.note = note
    line.resolved_by = user_id
    line.resolved_at = datetime.now(timezone.utc)
    return None
