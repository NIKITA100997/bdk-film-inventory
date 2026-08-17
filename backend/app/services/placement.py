"""Автоматический подбор места хранения (4.2 ТЗ). Тип стеллажа определяется
чистой функцией (тестируется без БД); поиск свободного места по правилам
макрозонирования обращается к БД, т.к. это по сути поиск по текущему
состоянию склада, а не вычисление из готовых данных."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.dictionaries import MaterialSku
from app.models.storage import MacroZoneRule, Rack, RackType
from app.models.units import MaterialUnit, UnitStatus


def determine_rack_type(sku: MaterialSku, width_mm: float, parent_id: int | None) -> RackType:
    """Совпадает с "родной" шириной рулона от поставщика — целый рулон, на
    рулонный стеллаж. Родная ширина неизвестна (не заполнена в справочнике
    материалов) — используем тот же признак, что и цвет индикатора на
    этикетке (services/labels.py): нет родителя — рулон, есть — штрипс."""
    if sku.native_width_mm is not None:
        return RackType.ROLL if abs(float(sku.native_width_mm) - width_mm) < 0.01 else RackType.STRIP
    return RackType.ROLL if parent_id is None else RackType.STRIP


def _rule_specificity(rule: MacroZoneRule) -> int:
    return sum(1 for v in (rule.material_id, rule.color_id, rule.thickness_id, rule.manufacturer_id) if v is not None)


def _rule_matches(rule: MacroZoneRule, sku: MaterialSku) -> bool:
    return (
        (rule.material_id is None or rule.material_id == sku.material_id)
        and (rule.color_id is None or rule.color_id == sku.color_id)
        and (rule.thickness_id is None or rule.thickness_id == sku.thickness_id)
        and (rule.manufacturer_id is None or rule.manufacturer_id == sku.manufacturer_id)
    )


def _occupied_counts(db: Session, rack_code: str) -> dict[str, int]:
    rows = (
        db.query(MaterialUnit.location_code)
        .filter(
            MaterialUnit.location_code.like(f"{rack_code}-%"),
            MaterialUnit.status.in_([UnitStatus.NA_KHRANENII, UnitStatus.PRINYAT]),
        )
        .all()
    )
    counts: dict[str, int] = {}
    for (code,) in rows:
        counts[code] = counts.get(code, 0) + 1
    return counts


def _find_free_slot(db: Session, rack: Rack, from_shelf: int, to_shelf: int) -> str | None:
    """Штрипсовые стеллажи адресуются так же, как рулонные (по полке
    целиком, без ячеек) — capacity ограничивает, сколько единиц может
    занимать один и тот же адрес одновременно (1 для рулонных, где полка
    = один рулон; rack.strip_capacity для штрипсовых)."""
    counts = _occupied_counts(db, rack.code)
    capacity = (rack.strip_capacity or 1) if rack.type == RackType.STRIP else 1
    for shelf in range(from_shelf, to_shelf + 1):
        code = f"{rack.code}-{shelf:02d}"
        if counts.get(code, 0) < capacity:
            return code
    return None


def suggest_location(
    db: Session,
    *,
    sku: MaterialSku,
    width_mm: float,
    parent_id: int | None,
    warehouse_id: int | None = None,
) -> str | None:
    """Возвращает рекомендованный адрес или None, если свободного места нет
    нигде — тогда операция не блокируется, адрес просто вводится вручную
    (4.2 ТЗ, п.4). warehouse_id — раздел про мультисклад: если передан,
    ищем только среди стеллажей этого склада; если нет — среди всех
    (обратная совместимость для вызовов до появления складов)."""
    rack_type = determine_rack_type(sku, width_mm, parent_id)
    query = db.query(Rack).filter(Rack.type == rack_type, Rack.is_active)
    if warehouse_id is not None:
        query = query.filter(Rack.warehouse_id == warehouse_id)
    racks = query.all()
    if not racks:
        return None
    racks_by_id = {r.id: r for r in racks}

    rules = db.query(MacroZoneRule).filter(MacroZoneRule.rack_id.in_(racks_by_id.keys())).all()
    matching = sorted((r for r in rules if _rule_matches(r, sku)), key=_rule_specificity, reverse=True)

    if not matching:
        # По требованию производства: если индивидуального правила зонирования нет,
        # автоподбор не помещает в произвольные ячейки, а просит настроить правило.
        return None

    candidates: list[tuple[int, int, int]] = [(r.rack_id, r.from_shelf, r.to_shelf) for r in matching]

    for rack_id, from_shelf, to_shelf in candidates:
        location = _find_free_slot(db, racks_by_id[rack_id], from_shelf, to_shelf)
        if location:
            return location
    return None
