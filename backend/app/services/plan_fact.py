"""Агрегация факта расхода по строке заказа (2.8 ТЗ, 4 раздел обратной
связи — план/факт считается по заказу, не по календарной неделе). Чистая
функция без БД, по образцу splitting.py: принимает уже выбранные из
журнала пары (width_mm, quantity_delta_m) и считает м², не заботясь о
том, как они получены."""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.orm import Session


@dataclass
class ActualAggregate:
    total_area_m2: float
    by_width: dict[float, float] = field(default_factory=dict)  # width_mm -> метры


def aggregate_actual(events: list[tuple[float, float]]) -> ActualAggregate:
    """`events` — пары (width_mm, quantity_delta_m) событий Выдача_участку/
    Списание. quantity_delta_m у этих событий отрицательный — берём модуль,
    факт расхода не может быть отрицательным."""
    total_area_m2 = 0.0
    by_width: dict[float, float] = {}
    for width_mm, quantity_delta_m in events:
        length_m = abs(quantity_delta_m)
        total_area_m2 += width_mm * length_m / 1000
        by_width[width_mm] = by_width.get(width_mm, 0.0) + length_m
    return ActualAggregate(total_area_m2=round(total_area_m2, 3), by_width=by_width)


def fetch_actual_for_orders(
    db: Session,
    *,
    order_ids: list[int],
    material_id: int,
    color_id: int,
    thickness_id: int,
) -> ActualAggregate:
    """Тянет из журнала события Выдача_участку/Списание, помеченные одним
    из указанных заказов (MaterialEvent.order_id — уже проставляется при
    каждой операции, см. services/events.py), для группы
    material+color+thickness (без производителя, как и сама строка
    потребности). Общая точка для план/факта заказа (один order_id) и
    карточки материала (несколько открытых заказов сразу)."""
    if not order_ids:
        return ActualAggregate(total_area_m2=0.0)

    from app.models.dictionaries import MaterialSku
    from app.models.events import EventType, MaterialEvent

    rows = (
        db.query(MaterialEvent.width_mm, MaterialEvent.quantity_delta_m)
        .join(MaterialSku, MaterialEvent.material_sku_id == MaterialSku.id)
        .filter(
            MaterialEvent.order_id.in_(order_ids),
            MaterialSku.material_id == material_id,
            MaterialSku.color_id == color_id,
            MaterialSku.thickness_id == thickness_id,
            MaterialEvent.event_type.in_([EventType.VYDACHA_UCHASTKU, EventType.SPISANIE]),
        )
        .all()
    )
    return aggregate_actual([(float(w), float(q)) for w, q in rows])
