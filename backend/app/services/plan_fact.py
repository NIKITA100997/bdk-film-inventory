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


def fetch_event_totals_by_unit(db: Session, unit_ids: list[int], event_type) -> dict[int, float]:
    """Σ|quantity_delta_m| по каждой единице для одного типа события —
    раздел про ревизию путей плёнки: переиспользуется для "сколько
    всего выдавалось"/"сколько всего списано" по конкретному рулону, а
    не по всей строке задания (та функция — fetch_issued_length_by_task_line
    выше — суммирует по СТРОКЕ, эта — по ЕДИНИЦЕ; рулон может пережить
    несколько выдач/строк за свою жизнь)."""
    if not unit_ids:
        return {}
    from app.models.events import MaterialEvent

    rows = (
        db.query(MaterialEvent.unit_id, func.sum(func.abs(MaterialEvent.quantity_delta_m)))
        .filter(MaterialEvent.unit_id.in_(unit_ids), MaterialEvent.event_type == event_type)
        .group_by(MaterialEvent.unit_id)
        .all()
    )
    return {unit_id: float(total) for unit_id, total in rows}


def fetch_consumed_length_by_unit(db: Session, unit_ids: list[int]) -> dict[int, float]:
    """Расход по отчётам (Σ(good+defect)×length_m строки, группировка по
    material_unit_id) — батч-версия _unit_consumed_length_m
    (api/production.py) для отчётов по многим рулонам разом, не по
    одному за раз. Та же арифметика (compute_unit_consumed_length_m),
    просто без похода в БД на каждый unit_id."""
    if not unit_ids:
        return {}
    from app.models.production import ProductionTaskLine, ProductionTaskLineReport
    from app.services.production import compute_unit_consumed_length_m

    rows = (
        db.query(
            ProductionTaskLineReport.material_unit_id,
            ProductionTaskLineReport.good_pieces,
            ProductionTaskLineReport.defect_pieces,
            ProductionTaskLine.length_m,
        )
        .join(ProductionTaskLine, ProductionTaskLineReport.task_line_id == ProductionTaskLine.id)
        .filter(ProductionTaskLineReport.material_unit_id.in_(unit_ids))
        .all()
    )
    by_unit: dict[int, list[tuple[float, float, float]]] = {}
    for unit_id, good, defect, length_m in rows:
        by_unit.setdefault(unit_id, []).append((float(good or 0), float(defect or 0), float(length_m)))
    return {uid: compute_unit_consumed_length_m(reps) for uid, reps in by_unit.items()}
