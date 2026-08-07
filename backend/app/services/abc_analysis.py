"""ABC-анализ ширин (2.9 ТЗ). Классификация — чистая функция без БД, по
образцу splitting.py/plan_fact.py; загрузка сырых данных и запись
результата — в вызывающем коде (api/abc.py)."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.abc import WidthClass


@dataclass
class WidthUsage:
    width_mm: float
    total_length_m: float


@dataclass
class WidthClassification:
    width_mm: float
    total_length_m: float
    width_class: WidthClass


def classify_widths(usage: list[WidthUsage]) -> list[WidthClassification]:
    """Топ ~80% расхода — класс А, следующие ~15% — B, остаток ~5% — C
    (2.9 ТЗ). Единственная ширина в выборке — всегда А: кумулятивная логика
    вырождается при n=1, а единственный вариант расхода очевидно "ходовой"."""
    total = sum(u.total_length_m for u in usage)
    if total <= 0:
        return []
    if len(usage) == 1:
        u = usage[0]
        return [WidthClassification(u.width_mm, u.total_length_m, WidthClass.A)]

    ordered = sorted(usage, key=lambda u: u.total_length_m, reverse=True)
    result: list[WidthClassification] = []
    cumulative = 0.0
    for u in ordered:
        cumulative += u.total_length_m
        pct = cumulative / total * 100
        if pct <= 80:
            width_class = WidthClass.A
        elif pct <= 95:
            width_class = WidthClass.B
        else:
            width_class = WidthClass.C
        result.append(WidthClassification(u.width_mm, u.total_length_m, width_class))
    return result


def recompute_abc_classes(db: Session, *, period_days: int) -> int:
    """Пересчитывает классы для всех комбинаций material+color+thickness,
    у которых была выдача участку за последние `period_days` дней (2.9 ТЗ:
    "например, 3 месяца"). Возвращает число обновлённых строк."""
    from sqlalchemy import func

    from app.models.abc import WidthAbcClass
    from app.models.dictionaries import MaterialSku
    from app.models.events import EventType, MaterialEvent

    date_from = dt.date.today() - dt.timedelta(days=period_days)

    rows = (
        db.query(
            MaterialSku.material_id,
            MaterialSku.color_id,
            MaterialSku.thickness_id,
            MaterialEvent.width_mm,
            func.sum(func.abs(MaterialEvent.quantity_delta_m)).label("total_length_m"),
        )
        .join(MaterialSku, MaterialEvent.material_sku_id == MaterialSku.id)
        .filter(
            MaterialEvent.event_type == EventType.VYDACHA_UCHASTKU,
            func.date(MaterialEvent.timestamp) >= date_from,
        )
        .group_by(MaterialSku.material_id, MaterialSku.color_id, MaterialSku.thickness_id, MaterialEvent.width_mm)
        .all()
    )

    groups: dict[tuple[int, int, int], list[WidthUsage]] = {}
    for material_id, color_id, thickness_id, width_mm, total_length_m in rows:
        key = (material_id, color_id, thickness_id)
        groups.setdefault(key, []).append(WidthUsage(float(width_mm), float(total_length_m)))

    written = 0
    for (material_id, color_id, thickness_id), usage in groups.items():
        for cls in classify_widths(usage):
            existing = (
                db.query(WidthAbcClass)
                .filter_by(material_id=material_id, color_id=color_id, thickness_id=thickness_id, width_mm=cls.width_mm)
                .first()
            )
            if existing is None:
                existing = WidthAbcClass(material_id=material_id, color_id=color_id, thickness_id=thickness_id, width_mm=cls.width_mm)
                db.add(existing)
            existing.width_class = cls.width_class
            existing.total_length_m = cls.total_length_m
            written += 1
    db.commit()
    return written
