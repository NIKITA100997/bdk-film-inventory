"""Агрегация факта расхода по позиции плана (2.8 ТЗ) — чистая функция без
БД, по образцу splitting.py: принимает уже выбранные из журнала пары
(width_mm, quantity_delta_m) и считает м², не заботясь о том, как они
получены."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

from sqlalchemy.orm import Session


@dataclass
class ActualAggregate:
    total_area_m2: float
    by_width: dict[float, float] = field(default_factory=dict)  # width_mm -> метры


def aggregate_actual(events: list[tuple[float, float]]) -> ActualAggregate:
    """`events` — пары (width_mm, quantity_delta_m) событий Выдача_участку/
    Списание за период (2.8 ТЗ). quantity_delta_m у этих событий
    отрицательный — берём модуль, факт расхода не может быть отрицательным."""
    total_area_m2 = 0.0
    by_width: dict[float, float] = {}
    for width_mm, quantity_delta_m in events:
        length_m = abs(quantity_delta_m)
        total_area_m2 += width_mm * length_m / 1000
        by_width[width_mm] = by_width.get(width_mm, 0.0) + length_m
    return ActualAggregate(total_area_m2=round(total_area_m2, 3), by_width=by_width)


def fetch_actual_for_group(
    db: Session,
    *,
    material_id: int,
    color_id: int,
    thickness_id: int,
    date_from: dt.date,
    date_to: dt.date,
) -> ActualAggregate:
    """Тянет из журнала события Выдача_участку/Списание за период для
    группы material+color+thickness (без производителя, 2.8 ТЗ) и считает
    факт через aggregate_actual. Общая точка для plan-fact и карточки
    материала — чтобы не дублировать запрос."""
    from sqlalchemy import func

    from app.models.dictionaries import MaterialSku
    from app.models.events import EventType, MaterialEvent

    rows = (
        db.query(MaterialEvent.width_mm, MaterialEvent.quantity_delta_m)
        .join(MaterialSku, MaterialEvent.material_sku_id == MaterialSku.id)
        .filter(
            MaterialSku.material_id == material_id,
            MaterialSku.color_id == color_id,
            MaterialSku.thickness_id == thickness_id,
            MaterialEvent.event_type.in_([EventType.VYDACHA_UCHASTKU, EventType.SPISANIE]),
            func.date(MaterialEvent.timestamp) >= date_from,
            func.date(MaterialEvent.timestamp) <= date_to,
        )
        .all()
    )
    return aggregate_actual([(float(w), float(q)) for w, q in rows])
