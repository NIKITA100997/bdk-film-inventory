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


def _occupied_codes(db: Session, rack_code: str) -> set[str]:
    rows = (
        db.query(MaterialUnit.location_code)
        .filter(
            MaterialUnit.location_code.like(f"{rack_code}-%"),
            MaterialUnit.status.in_([UnitStatus.NA_KHRANENII, UnitStatus.PRINYAT]),
        )
        .all()
    )
    return {r[0] for r in rows}


def _find_free_slot(db: Session, rack: Rack, from_shelf: int, to_shelf: int, cells_per_strip_shelf: int) -> str | None:
    occupied = _occupied_codes(db, rack.code)
    if rack.type == RackType.ROLL:
        for shelf in range(from_shelf, to_shelf + 1):
            code = f"{rack.code}-{shelf:02d}"
            if code not in occupied:
                return code
        return None

    for shelf in range(from_shelf, to_shelf + 1):
        for cell in range(1, cells_per_strip_shelf + 1):
            code = f"{rack.code}-{shelf:02d}-{cell:02d}"
            if code not in occupied:
                return code
    return None


def suggest_location(
    db: Session,
    *,
    sku: MaterialSku,
    width_mm: float,
    parent_id: int | None,
    cells_per_strip_shelf: int = 10,
    warehouse_id: int | None = None,
) -> str | None:
    """Возвращает рекомендованный адрес или None, если свободного места нет
    нигде — тогда операция не блокируется, адрес просто вводится вручную
    (4.2 ТЗ, п.4). cells_per_strip_shelf — настраиваемое значение
    (CalcSettings, 5 раздел бэклога доработок), раньше было захардкожено.
    warehouse_id — раздел про мультисклад: если передан, ищем только среди
    стеллажей этого склада; если нет — среди всех (обратная совместимость
    для вызовов до появления складов)."""
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

    candidates: list[tuple[int, int, int]] = [(r.rack_id, r.from_shelf, r.to_shelf) for r in matching]
    # Ни одно правило не подошло (или зона занята) — пробуем весь диапазон
    # каждого стеллажа нужного типа как буферную зону (раздел 4.2).
    for rack in racks:
        candidates.append((rack.id, 1, rack.shelf_count))

    for rack_id, from_shelf, to_shelf in candidates:
        location = _find_free_slot(db, racks_by_id[rack_id], from_shelf, to_shelf, cells_per_strip_shelf)
        if location:
            return location
    return None
