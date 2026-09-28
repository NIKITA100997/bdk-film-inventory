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
