"""Пересчёт п/ф на участке (models/part_counts.py): лист по охвату, сравнение
«по учёту / факт» и применение решения по строке через операции партий."""
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.orm import Session, joinedload

from app.models.dictionaries import Part, PartStage
from app.models.items import Item, ItemGroup, ItemType
from app.models.part_counts import (
    DECISION_ACCEPT,
    DECISION_KEEP,
    DECISION_WRITE_OFF,
    PartCountLine,
    PartCountSession,
)
from app.models.part_units import PartUnit, PartUnitStatus
from app.services import item_attrs
from app.services.part_units import (
    adjust_part_unit,
    mint_part_unit,
    reported_good_pieces_by_unit,
    write_off_part_unit,
)

COUNTABLE_STATUSES = (PartUnitStatus.VYDAN_UCHASTKU, PartUnitStatus.NA_KHRANENII)


def diff_of(expected: float, counted: float | None) -> float | None:
    """Факт − учёт: <0 недостача, >0 излишек, 0 сошлось, None — не считали."""
    if counted is None:
        return None
    return round(float(counted) - float(expected), 2)


def allowed_decisions(expected: float, counted: float | None) -> list[str]:
    """Какие решения допустимы по строке: недостача — списать или оставить,
    излишек — оприходовать или оставить, сошлось / не считали — нечего решать."""
    d = diff_of(expected, counted)
    if not d:
        return []
    return [DECISION_WRITE_OFF, DECISION_KEEP] if d < 0 else [DECISION_ACCEPT, DECISION_KEEP]


def group_with_descendants(db: Session, group_ids: list[int]) -> set[int]:
    children: dict[int | None, list[int]] = {}
    for g in db.query(ItemGroup.id, ItemGroup.parent_id):
        children.setdefault(g.parent_id, []).append(g.id)
    out: set[int] = set()
    stack = list(group_ids)
    while stack:
        g = stack.pop()
        if g in out:
            continue
        out.add(g)
        stack.extend(children.get(g, []))
    return out


def free_qty(db: Session, units: list[PartUnit]) -> dict[int, float]:
    reported = reported_good_pieces_by_unit(db, [u.id for u in units])
    return {u.id: max(0.0, float(u.quantity_pieces) - reported.get(u.id, 0.0)) for u in units}


def lots_in_scope(db: Session, area: str, scope: dict | None) -> list[PartUnit]:
    """Партии на участке в охвате пересчёта: группы номенклатуры (с
    подгруппами) и стадии позиции (заготовка / без плёнки / в плёнке)."""
    q = (
        db.query(PartUnit)
        .options(joinedload(PartUnit.part), joinedload(PartUnit.stage))
        .filter(PartUnit.area == area, PartUnit.status.in_(COUNTABLE_STATUSES))
    )
    units = q.all()
    scope = scope or {}
    group_ids = scope.get("group_ids") or []
    stages = set(scope.get("stages") or [])
    if group_ids or stages:
        groups = group_with_descendants(db, group_ids) if group_ids else None
        item_ids = {u.part.item_id for u in units if u.part.item_id}
        items = {i.id: i for i in db.query(Item).filter(Item.id.in_(item_ids))} if item_ids else {}
        types = {t.id: t for t in db.query(ItemType)}

        def fits(u: PartUnit) -> bool:
            item = items.get(u.part.item_id)
            if item is None:
                return False
            if groups is not None and item.group_id not in groups:
                return False
            if stages:
                st = item_attrs.effective_stage(item, types.get(item.type_id) if item.type_id else None)
                if st not in stages:
                    return False
            return True

        units = [u for u in units if fits(u)]
    free = free_qty(db, units)
    return [u for u in units if free[u.id] > 0]


def build_lines(db: Session, session: PartCountSession) -> int:
    units = lots_in_scope(db, session.area, session.scope)
    free = free_qty(db, units)
    for u in units:
        db.add(
            PartCountLine(
                session_id=session.id, part_unit_id=u.id, part_id=u.part_id, stage_id=u.stage_id, expected_qty=free[u.id]
            )
        )
    return len(units)


def current_free(db: Session, line: PartCountLine) -> float:
    if line.part_unit_id is None:
        return 0.0
    unit = db.get(PartUnit, line.part_unit_id)
    if unit is None or unit.status not in COUNTABLE_STATUSES:
        return 0.0
    return free_qty(db, [unit])[unit.id]


@dataclass
class ResolveResult:
    part_unit_id: int | None


def resolve_line(
    db: Session,
    *,
    session: PartCountSession,
    line: PartCountLine,
    decision: str,
    reason: str | None,
    note: str | None,
    user_id: int,
) -> ResolveResult:
    """Применить решение по строке закрытого пересчёта. Недостача списывается
    с партии строки (не больше её свободного остатка), излишек добавляется к
    партии или заводится новой партией на этапе строки."""
    d = diff_of(float(line.expected_qty), None if line.counted_qty is None else float(line.counted_qty))
    if decision not in allowed_decisions(float(line.expected_qty), None if line.counted_qty is None else float(line.counted_qty)):
        raise ValueError("Для этой строки такое решение недоступно")
    tag = f"Пересчёт №{session.id}"
    full_note = f"{tag}{' — ' + note if note else ''}"
    result_id: int | None = line.part_unit_id
    if decision == DECISION_WRITE_OFF:
        if not reason:
            raise ValueError("Укажите причину списания")
        unit = db.get(PartUnit, line.part_unit_id)
        qty = min(-d, current_free(db, line))
        if qty <= 0:
            raise ValueError("Списывать нечего — партия уже израсходована")
        write_off_part_unit(db, unit=unit, quantity_pieces=qty, reason=reason, user_id=user_id, note=full_note)
    elif decision == DECISION_ACCEPT:
        if line.part_unit_id is not None:
            unit = db.get(PartUnit, line.part_unit_id)
            adjust_part_unit(
                db, unit=unit, actual_quantity_pieces=float(unit.quantity_pieces) + d, reason=tag, user_id=user_id, note=note
            )
        else:
            part = db.get(Part, line.part_id)
            new = mint_part_unit(
                db, part=part, quantity_pieces=d, user_id=user_id, stage_id=line.stage_id, note=f"Излишек: {full_note}"
            )
            db.flush()
            result_id = new.id
            line.result_part_unit_id = new.id
    line.decision = decision
    line.reason = reason if decision == DECISION_WRITE_OFF else None
    line.note = note
    line.resolved_by = user_id
    line.resolved_at = datetime.now(timezone.utc)
    return ResolveResult(part_unit_id=result_id)


def stage_at_area(db: Session, part_id: int, area: str) -> PartStage | None:
    """Этап детали на этом участке — для найденного сверх листа."""
    part = db.get(Part, part_id)
    if part is None:
        return None
    here = [s for s in part.stages if s.area == area]
    return max(here, key=lambda s: s.sequence_order) if here else None
