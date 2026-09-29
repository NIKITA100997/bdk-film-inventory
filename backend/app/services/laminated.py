"""Деталь в плёнке — отдельная позиция «деталь · декор» со своим остатком.

Деталь без плёнки универсальна (окутать можно в любой декор), деталь в
плёнке — только в свой. Поэтому излишек окутки (сделали больше плана
строки) уходит в остаток не той же деталью, а позицией в декоре строки:
«Багет Б-4/М 28х61х1840 ПАЗ-4 · ПВХ Дуб Сонома». Позиция создаётся сама
при первом таком излишке (как размеры), маршрут — один этап «Готово».
"""

from datetime import date

from sqlalchemy.orm import Session

from app.core.constants import PART_UNIT_AUTO_WRITE_OFF_REASON_CODE
from app.models.dictionaries import Color, Material, Part, PartStage
from app.models.items import Item, ItemType
from app.models.part_units import PartEventType, PartUnit, PartUnitStatus
from app.services import item_attrs
from app.services.part_units import record_part_event, write_off_part_unit

NO_MATERIAL = "Неизвестно"
READY_STAGE = "Готово"


def decor_label(db: Session, material_id: int | None, color_id: int) -> str:
    color = db.get(Color, color_id)
    material = db.get(Material, material_id) if material_id else None
    name = color.name if color else f"цвет #{color_id}"
    if material and material.name != NO_MATERIAL:
        return f"{material.name} {name}"
    return name


def can_laminate(db: Session, part: Part | None) -> bool:
    """Позицию в плёнке заводим только от детали без плёнки (или заготовки):
    уже ламинированная панель щита — сама себе «в плёнке»."""
    if part is None or part.item_id is None:
        return False
    item = db.get(Item, part.item_id)
    if item is None or item.base_item_id is not None:
        return False
    t = db.get(ItemType, item.type_id) if item.type_id else None
    return item_attrs.effective_stage(item, t) != "laminated"


def laminated_part(db: Session, base_part: Part, material_id: int | None, color_id: int) -> Part:
    """Найти или создать позицию «деталь · декор» (позиция + деталь + этап
    «Готово»). Направление и ПЭТ — как у детали без плёнки."""
    base_item = db.get(Item, base_part.item_id)
    item = (
        db.query(Item)
        .filter(Item.base_item_id == base_item.id, Item.decor_material_id == material_id, Item.decor_color_id == color_id)
        .first()
    )
    if item is not None:
        part = db.query(Part).filter(Part.item_id == item.id).first()
        if part is not None:
            return part
    name = f"{base_item.name} · {decor_label(db, material_id, color_id)}"[:255]
    if item is None:
        t = db.get(ItemType, base_item.type_id) if base_item.type_id else None
        item = Item(
            kind_id=base_item.kind_id, name=name, group_id=base_item.group_id, unit=base_item.unit,
            direction=item_attrs.effective_direction(base_item, t), stage="laminated", pet_type=base_item.pet_type,
            base_item_id=base_item.id, decor_material_id=material_id, decor_color_id=color_id, is_active=True,
        )
        db.add(item)
        db.flush()
    part = db.query(Part).filter(Part.name == name).first()
    if part is None:
        part = Part(
            name=name, width_mm=base_part.width_mm, length_m=base_part.length_m, strip_width_mm=None, area=None,
            is_active=True, item_id=item.id,
        )
        db.add(part)
        db.flush()
    elif part.item_id != item.id:
        part.item_id = item.id
    if not db.query(PartStage.id).filter(PartStage.item_id == item.id).first():
        db.add(PartStage(item_id=item.id, part_id=part.id, sequence_order=1, code="gotovo", name=READY_STAGE, area=None))
        db.flush()
    db.refresh(part)
    return part


def laminated_excess(
    db: Session,
    *,
    base_part: Part,
    material_id: int | None,
    color_id: int,
    area: str,
    quantity_pieces: float,
    user_id: int,
    task_line_id: int | None,
    bare_unit: PartUnit | None = None,
) -> PartUnit:
    """Излишек окутки → партия позиции «деталь · декор» на хранении на
    участке. Если деталь без плёнки учитывается партиями (bare_unit), столько
    же штук её списывается — физически это те же детали, теперь в плёнке."""
    lam = laminated_part(db, base_part, material_id, color_id)
    stage = sorted(lam.stages, key=lambda s: s.sequence_order)[0]
    unit = PartUnit(
        part_id=lam.id, quantity_pieces=quantity_pieces, stage_id=stage.id, manufactured_at=date.today(),
        status=PartUnitStatus.NA_KHRANENII, area=area, production_task_line_id=task_line_id,
        note="Излишек окутки сверх плана строки", created_by=user_id,
    )
    db.add(unit)
    db.flush()
    record_part_event(
        db, unit=unit, event_type=PartEventType.PROIZVODSTVO, user_id=user_id, quantity_delta=quantity_pieces,
        to_stage_id=stage.id, related_part_unit_id=bare_unit.id if bare_unit else None,
        note="Излишек окутки сверх плана строки" + (f" — из партии №{bare_unit.id}" if bare_unit else ""),
    )
    if bare_unit is not None:
        write_off_part_unit(
            db, unit=bare_unit, quantity_pieces=quantity_pieces, reason=PART_UNIT_AUTO_WRITE_OFF_REASON_CODE,
            user_id=user_id, note=f"Окутано в «{lam.name}» → партия №{unit.id}",
        )
    return unit
