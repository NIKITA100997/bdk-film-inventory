"""Материалы (вид «Материал»): остаток одним числом на склад — сумма
движений (MaterialMove). Приход, списание и инвентаризация — вручную;
расход — сам, по отчёту операции, на которой материал по составу нужен
(production_orders.consume_components_at_operation), и в минус тоже."""

from collections import defaultdict
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.items import (
    MOVE_ADJUST,
    MOVE_CONSUMPTION,
    MOVE_RECEIPT,
    MOVE_WRITEOFF,
    Item,
    MaterialMove,
)

KIND_MATERIAL = "material"


def balances(db: Session, item_ids: list[int] | None = None) -> dict[int, float]:
    q = db.query(MaterialMove.item_id, func.coalesce(func.sum(MaterialMove.qty), 0)).group_by(MaterialMove.item_id)
    if item_ids is not None:
        if not item_ids:
            return {}
        q = q.filter(MaterialMove.item_id.in_(item_ids))
    return defaultdict(float, {i: float(v) for i, v in q})


def record(
    db: Session, *, item: Item, kind: str, qty: float, user_id: int, task_line_id: int | None = None,
    doc: str | None = None, note: str | None = None, occurred_at: datetime | None = None,
) -> MaterialMove:
    """Записать движение (без commit). qty — со знаком."""
    move = MaterialMove(
        item_id=item.id, kind=kind, qty=round(qty, 4), user_id=user_id, task_line_id=task_line_id,
        doc=(doc or "").strip()[:64] or None, note=(note or "").strip()[:255] or None,
    )
    if occurred_at is not None:
        move.occurred_at = occurred_at
    db.add(move)
    db.flush()
    return move


def manual_move(
    db: Session, *, item: Item, kind: str, qty: float, user_id: int, doc: str | None = None, note: str | None = None,
    occurred_at: datetime | None = None,
) -> MaterialMove:
    """Приход (qty > 0), списание (qty > 0 — сколько списать) или
    инвентаризация (qty — фактический остаток: пишется разница)."""
    if item.kind.code != KIND_MATERIAL:
        raise ValueError("Движения — только у позиций вида «Материал»")
    if kind == MOVE_RECEIPT:
        if qty <= 0:
            raise ValueError("Приход — больше нуля")
        delta = qty
    elif kind == MOVE_WRITEOFF:
        if qty <= 0:
            raise ValueError("Списание — больше нуля")
        if not (note or "").strip():
            raise ValueError("Укажите причину списания")
        delta = -qty
    elif kind == MOVE_ADJUST:
        if qty < 0:
            raise ValueError("Фактический остаток не может быть отрицательным")
        delta = qty - balances(db, [item.id])[item.id]
        if abs(delta) < 1e-9:
            raise ValueError("Факт совпадает с остатком — корректировать нечего")
        note = note or f"Инвентаризация: факт {qty:g}"
    else:
        raise ValueError("Неизвестная операция")
    return record(db, item=item, kind=kind, qty=delta, user_id=user_id, doc=doc, note=note, occurred_at=occurred_at)


def consume(
    db: Session, *, item: Item, qty: float, user_id: int, task_line_id: int | None, note: str | None
) -> MaterialMove | None:
    """Расход в производство по отчёту операции (в минус тоже)."""
    if qty <= 0:
        return None
    return record(db, item=item, kind=MOVE_CONSUMPTION, qty=-qty, user_id=user_id, task_line_id=task_line_id, note=note)


def demand_by_item(db: Session) -> dict[int, list[tuple[int, str, int | None, float]]]:
    """Потребность в материалах по открытым операциям (08.10): строка задания
    с операцией (заказ на производство или задание на п/ф) × состав позиции
    на этой операции × ещё не сделанное по строке. То же правило, по
    которому материал списывается при отчёте
    (production_orders.consume_components_at_operation): компонент без
    операции — на первой операции позиции; из группы «или» — основной
    вариант. → {материал: [(задание, название, заказ, сколько)]}."""
    from app.models.dictionaries import PartStage
    from app.models.items import ItemComponent, ItemKind
    from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
    from app.services.components import planned_components

    mat_kind = db.query(ItemKind).filter(ItemKind.code == KIND_MATERIAL).first()
    if mat_kind is None:
        return {}
    lines = (
        db.query(ProductionTaskLine, ProductionTask)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(
            ProductionTask.is_active.is_(True),
            ProductionTaskLine.part_stage_id.isnot(None),
            ProductionTaskLine.production_closed.is_(False),
        )
        .all()
    )
    if not lines:
        return {}
    done = dict(
        db.query(
            ProductionTaskLineReport.task_line_id,
            func.coalesce(func.sum(ProductionTaskLineReport.good_pieces + ProductionTaskLineReport.defect_pieces), 0),
        )
        .filter(ProductionTaskLineReport.task_line_id.in_([ln.id for ln, _ in lines]))
        .group_by(ProductionTaskLineReport.task_line_id)
    )
    stages = {s.id: s for s in db.query(PartStage).filter(PartStage.id.in_({ln.part_stage_id for ln, _ in lines}))}
    item_ids = {s.item_id for s in stages.values()}
    first_stage = dict(
        db.query(PartStage.item_id, func.min(PartStage.sequence_order)).filter(PartStage.item_id.in_(item_ids)).group_by(PartStage.item_id)
    )
    materials = {i.id for i in db.query(Item.id).filter(Item.kind_id == mat_kind.id)}
    raw: dict[int, list] = defaultdict(list)
    for c in db.query(ItemComponent).filter(ItemComponent.parent_item_id.in_(item_ids)):
        raw[c.parent_item_id].append(c)
    # группы «или» — у каждой позиции свои, поэтому по позициям отдельно
    comps_by_item = {
        pid: [c for c in planned_components(cs) if c.component_item_id in materials] for pid, cs in raw.items()
    }
    out: dict[int, list[tuple[int, str, int | None, float]]] = defaultdict(list)
    for ln, t in lines:
        st = stages.get(ln.part_stage_id)
        if st is None:
            continue
        left = max(0.0, float(ln.quantity_pieces) - float(done.get(ln.id, 0)))
        if left <= 0:
            continue
        is_first = first_stage.get(st.item_id) == st.sequence_order
        for c in comps_by_item.get(st.item_id, []):
            if c.stage_id == st.id or (c.stage_id is None and is_first):
                out[c.component_item_id].append((t.id, t.name or f"Задание №{t.id}", t.production_order_id, float(c.qty_per_unit) * left))
    return out
