"""Предупреждения о плёнке у строки задания (не запрет — работу не
останавливают, пока справочники заполняются):

- ПЭТ 2Д/3Д: у детали признак (items.pet_type, пусто — 2Д), в строке — ПЭТ
  другого типа;
- на участке лежат партии детали «после снятия плёнки» (пометка «Ламис»),
  а плёнка строки — не ПВХ («Ламис» — это ПВХ, 06.10): эти партии в строку не пойдут.
"""

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.dictionaries import Color, Material, Part
from app.models.items import Item
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.production import ProductionTaskLine
from app.services.part_units import LAMIS_COLLECTION, LAMIS_RESTRICTION

PET_LABEL = {"2d": "ПЭТ 2Д", "3d": "ПЭТ 3Д"}


def pet_of_material(name: str | None) -> str | None:
    """«ПЭТ 3Д» → "3d", «ПЭТ 2Д» → "2d", не ПЭТ — None."""
    low = (name or "").lower().replace(" ", "")
    if "пэт" not in low:
        return None
    if "3д" in low:
        return "3d"
    if "2д" in low:
        return "2d"
    return None


def is_lamis_film(material: Material | None, decor: Color | None) -> bool:
    """«Ламис» — это ПВХ-плёнки (ответ пользователя 06.10): деталь после
    снятия плёнки переклеивается любой ПВХ. Коллекция «Ламис» у цвета —
    по-прежнему признак (ручная отметка не теряется)."""
    if material is not None and normalize_film(material.name).startswith("пвх"):
        return True
    return bool(decor and (decor.collection or "").strip().lower() == LAMIS_COLLECTION)


def normalize_film(name: str | None) -> str:
    return (name or "").strip().lower().replace("ё", "е")


def film_warnings(db: Session, line: ProductionTaskLine) -> list[str]:
    if line.material_id is None or line.part_id is None:
        return []
    out: list[str] = []
    part = db.get(Part, line.part_id)
    item = db.get(Item, part.item_id) if part and part.item_id else None
    material = db.get(Material, line.material_id)
    line_pet = pet_of_material(material.name if material else None)
    if item is not None and line_pet is not None:
        part_pet = item.pet_type or "2d"
        if part_pet != line_pet:
            out.append(f"Деталь клеится {PET_LABEL[part_pet]}, а в строке {PET_LABEL[line_pet]}")
    decor = db.get(Color, line.color_id) if line.color_id else None
    decor_is_lamis = is_lamis_film(material, decor)
    if part is not None and not decor_is_lamis:
        held = float(
            db.query(func.coalesce(func.sum(PartUnit.quantity_pieces), 0))
            .filter(
                PartUnit.part_id == part.id,
                PartUnit.area == line.task.area,
                PartUnit.status == PartUnitStatus.VYDAN_UCHASTKU,
                PartUnit.film_restriction == LAMIS_RESTRICTION,
            )
            .scalar()
        )
        if held > 0:
            out.append(f"На участке {held:g} шт после снятия плёнки — их можно клеить только ПВХ («Ламис»)")
    return out
