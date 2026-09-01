"""Поиск/автосоздание позиции материала по текстовым значениям (2.1a/5.6 ТЗ).

Хранится всё через ссылки на справочники, но склад продолжает вводить
текстом (с автокомплитом на фронтенде) — эти функции транслируют текст в
ссылки, создавая недостающие записи справочников только там, где это
осмысленно (приёмка), и не создавая их при поиске/выдаче, чтобы опечатка не
плодила фантомные позиции.
"""

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.abc import WidthAbcClass
from app.models.dictionaries import Color, Employee, Manufacturer, Material, MaterialSku, Part, Thickness
from app.models.production import (
    ProductionTask,
    ProductionTaskLine,
    ProductionTaskLineAssignment,
    ProductionTaskLineReport,
)
from app.models.purchasing import PurchaseRequest, Supplier
from app.models.storage import MacroZoneRule
from app.models.units import MaterialUnit, UnitStatus


def _find_or_create(db: Session, model, **filters):
    obj = db.query(model).filter_by(**filters).first()
    if obj is None:
        obj = model(**filters)
        db.add(obj)
        db.flush()
    return obj


def find_or_create_sku(db: Session, *, material: str, color: str, thickness: float, manufacturer: str) -> MaterialSku:
    material_obj = _find_or_create(db, Material, name=material)
    color_obj = _find_or_create(db, Color, name=color)
    thickness_obj = _find_or_create(db, Thickness, value_mm=thickness)
    manufacturer_obj = _find_or_create(db, Manufacturer, name=manufacturer)

    sku = (
        db.query(MaterialSku)
        .filter_by(
            material_id=material_obj.id,
            color_id=color_obj.id,
            thickness_id=thickness_obj.id,
            manufacturer_id=manufacturer_obj.id,
        )
        .first()
    )
    if sku is None:
        sku = MaterialSku(
            material_id=material_obj.id,
            color_id=color_obj.id,
            thickness_id=thickness_obj.id,
            manufacturer_id=manufacturer_obj.id,
        )
        db.add(sku)
        db.flush()
    return sku


def find_or_create_material_color_thickness(
    db: Session, *, material: str, color: str, thickness: float
) -> tuple[Material, Color, Thickness]:
    """Для заявки на плёнку (2.7 ТЗ) — без производителя, план не привязан к
    конкретному поставщику."""
    material_obj = _find_or_create(db, Material, name=material)
    color_obj = _find_or_create(db, Color, name=color)
    thickness_obj = _find_or_create(db, Thickness, value_mm=thickness)
    return material_obj, color_obj, thickness_obj


def find_or_create_supplier(db: Session, name: str) -> Supplier:
    """Поставщик (раздел про историю цен и сроков) — тот же паттерн
    текст-с-автокомплитом-создаёт-справочник, что и остальные атрибуты."""
    return _find_or_create(db, Supplier, name=name)


def find_or_create_employees(db: Session, names: list[str]) -> None:
    """Сотрудники цеха (раздел про автокомплит) — employee_names остаётся
    свободным текстом с несколькими именами через запятую (не FK), это
    только заводит каждое новое имя в справочник для будущих подсказок —
    не требует прав materials.manage, ровно как заведение нового
    материала/цвета при приёмке не требует их от кладовщика."""
    for raw in names:
        name = raw.strip()
        if name:
            _find_or_create(db, Employee, name=name)


def find_sku(db: Session, *, material: str, color: str, thickness: float, manufacturer: str) -> MaterialSku | None:
    material_obj = db.query(Material).filter_by(name=material).first()
    color_obj = db.query(Color).filter_by(name=color).first()
    thickness_obj = db.query(Thickness).filter_by(value_mm=thickness).first()
    manufacturer_obj = db.query(Manufacturer).filter_by(name=manufacturer).first()
    if not (material_obj and color_obj and thickness_obj and manufacturer_obj):
        return None
    return (
        db.query(MaterialSku)
        .filter_by(
            material_id=material_obj.id,
            color_id=color_obj.id,
            thickness_id=thickness_obj.id,
            manufacturer_id=manufacturer_obj.id,
        )
        .first()
    )


def _normalize_part_name(name: str) -> str:
    return name.strip().lower().replace("ё", "е")


def sync_part_to_task_lines(db: Session, part: Part, previous_name: str | None = None) -> list[ProductionTaskLine]:
    """Правка детали в справочнике "на лету" (пока размеры ещё тестируются)
    — width_mm/length_m/strip_width_mm копируются в строку задания один раз
    при создании (blank_plan_import/ручной ввод) и дальше живут независимо
    от справочника. Пока идёт тестирование значений, правка детали ПОСЛЕ
    того, как задание уже создано, должна долетать до него сама, а не ждать
    следующей загрузки — тянем изменение в подходящие строки уже активных
    заданий тут же. Не трогаем строки, по которым уже была резка/отчёт о
    выпуске/распределение по линии — менять исходный размер задним числом
    после того, как по нему уже реально резали или отчитывались, опаснее,
    чем оставить расхождение видимым."""
    names = {part.name}
    if previous_name and previous_name != part.name:
        names.add(previous_name)
    normalized_names = {_normalize_part_name(n) for n in names}

    candidates = (
        db.query(ProductionTaskLine)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTask.is_active.is_(True))
        .filter(ProductionTaskLine.part_name.isnot(None))
        .all()
    )
    matching = [line for line in candidates if _normalize_part_name(line.part_name) in normalized_names]
    if not matching:
        return []

    line_ids = [line.id for line in matching]
    touched_ids: set[int] = set()
    touched_ids.update(
        row[0]
        for row in db.query(MaterialUnit.production_task_line_id)
        .filter(MaterialUnit.production_task_line_id.in_(line_ids))
        .distinct()
    )
    touched_ids.update(
        row[0]
        for row in db.query(ProductionTaskLineReport.task_line_id)
        .filter(ProductionTaskLineReport.task_line_id.in_(line_ids))
        .distinct()
    )
    touched_ids.update(
        row[0]
        for row in db.query(ProductionTaskLineAssignment.task_line_id)
        .filter(ProductionTaskLineAssignment.task_line_id.in_(line_ids))
        .distinct()
    )

    updated: list[ProductionTaskLine] = []
    for line in matching:
        if line.id in touched_ids:
            continue
        changed = False
        if part.width_mm is not None and line.width_mm != part.width_mm:
            line.width_mm = part.width_mm
            changed = True
        if part.length_m is not None and line.length_m != part.length_m:
            line.length_m = part.length_m
            changed = True
        if part.strip_width_mm is not None and line.strip_width_mm != part.strip_width_mm:
            line.strip_width_mm = part.strip_width_mm
            changed = True
        if changed:
            updated.append(line)
    return updated


def current_stock_m2(db: Session, *, material_id: int, color_id: int, thickness_id: int) -> float:
    """Σ area_m2 по группе material+color+thickness (без производителя — и
    заявка на плёнку, и заявка снабженцу оперируют группой, 2.7/5.5 ТЗ),
    кроме списанных. Общий хелпер для плана/факта и закупок."""
    total = (
        db.query(func.sum(MaterialUnit.width_mm * MaterialUnit.length_m))
        .join(MaterialSku, MaterialUnit.material_sku_id == MaterialSku.id)
        .filter(
            MaterialSku.material_id == material_id,
            MaterialSku.color_id == color_id,
            MaterialSku.thickness_id == thickness_id,
            MaterialUnit.status != UnitStatus.SPISAN,
        )
        .scalar()
    )
    return round(float(total or 0) / 1000, 3)


# Раздел про удаление неиспользуемых записей справочника — материал/цвет/
# толщина упоминаются напрямую (не только через MaterialSku) ещё в четырёх
# таблицах: MacroZoneRule (правило зонирования, поля необязательные — NULL
# означает "любое значение", а не привязку к конкретной записи, потому
# фильтруем именно на равенство id, не просто на непустоту строки),
# WidthAbcClass/ProductionTaskLine/PurchaseRequest (везде обязательные).
# Производитель — только в MaterialSku/MacroZoneRule, третьей стороны у него
# нет ни в одной из остальных трёх таблиц.
def material_in_use(db: Session, material_id: int) -> bool:
    return (
        db.query(MaterialSku.id).filter(MaterialSku.material_id == material_id).first() is not None
        or db.query(MacroZoneRule.id).filter(MacroZoneRule.material_id == material_id).first() is not None
        or db.query(WidthAbcClass.id).filter(WidthAbcClass.material_id == material_id).first() is not None
        or db.query(ProductionTaskLine.id).filter(ProductionTaskLine.material_id == material_id).first() is not None
        or db.query(PurchaseRequest.id).filter(PurchaseRequest.material_id == material_id).first() is not None
    )


def color_in_use(db: Session, color_id: int) -> bool:
    return (
        db.query(MaterialSku.id).filter(MaterialSku.color_id == color_id).first() is not None
        or db.query(MacroZoneRule.id).filter(MacroZoneRule.color_id == color_id).first() is not None
        or db.query(WidthAbcClass.id).filter(WidthAbcClass.color_id == color_id).first() is not None
        or db.query(ProductionTaskLine.id).filter(ProductionTaskLine.color_id == color_id).first() is not None
        or db.query(PurchaseRequest.id).filter(PurchaseRequest.color_id == color_id).first() is not None
    )


def thickness_in_use(db: Session, thickness_id: int) -> bool:
    return (
        db.query(MaterialSku.id).filter(MaterialSku.thickness_id == thickness_id).first() is not None
        or db.query(MacroZoneRule.id).filter(MacroZoneRule.thickness_id == thickness_id).first() is not None
        or db.query(WidthAbcClass.id).filter(WidthAbcClass.thickness_id == thickness_id).first() is not None
        or db.query(ProductionTaskLine.id).filter(ProductionTaskLine.thickness_id == thickness_id).first() is not None
        or db.query(PurchaseRequest.id).filter(PurchaseRequest.thickness_id == thickness_id).first() is not None
    )


def manufacturer_in_use(db: Session, manufacturer_id: int) -> bool:
    return (
        db.query(MaterialSku.id).filter(MaterialSku.manufacturer_id == manufacturer_id).first() is not None
        or db.query(MacroZoneRule.id).filter(MacroZoneRule.manufacturer_id == manufacturer_id).first() is not None
    )
