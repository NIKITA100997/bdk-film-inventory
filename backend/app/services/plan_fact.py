"""Агрегация факта расхода плёнки по журналу событий (по образцу
splitting.py — чистые функции без побочных эффектов)."""

from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.orm import Session


def fetch_issued_length_by_task_line(db: Session, task_line_ids: list[int]) -> dict[int, float]:
    """Сколько метров плёнки реально выдано под каждую строку задания
    (раздел "Выдано по заданиям" на экране "Выдача участку") — сумма
    Выдача_участку событий журнала, один запрос на все строки задания, не
    N+1. Возврат/списание сюда не подмешиваются — это отдельный вопрос
    "сколько осталось", не "сколько выдавалось"."""
    if not task_line_ids:
        return {}

    from app.models.events import EventType, MaterialEvent

    rows = (
        db.query(MaterialEvent.production_task_line_id, func.sum(func.abs(MaterialEvent.quantity_delta_m)))
        .filter(
            MaterialEvent.production_task_line_id.in_(task_line_ids),
            MaterialEvent.event_type == EventType.VYDACHA_UCHASTKU,
        )
        .group_by(MaterialEvent.production_task_line_id)
        .all()
    )
    return {task_line_id: float(total) for task_line_id, total in rows}
