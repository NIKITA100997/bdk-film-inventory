"""Поиск/автосоздание позиции материала по текстовым значениям (2.1a/5.6 ТЗ).

Хранится всё через ссылки на справочники, но склад продолжает вводить
текстом (с автокомплитом на фронтенде) — эти функции транслируют текст в
ссылки, создавая недостающие записи справочников только там, где это
осмысленно (приёмка), и не создавая их при поиске/выдаче, чтобы опечатка не
плодила фантомные позиции.
"""

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.dictionaries import Color, Manufacturer, Material, MaterialSku, Thickness
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
