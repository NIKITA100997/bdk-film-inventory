from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_roles
from app.db.session import get_db
from app.models.abc import CalcSettings
from app.models.dictionaries import Color, Manufacturer, Material, MaterialSku, Thickness
from app.models.storage import MacroZoneRule, Rack
from app.schemas.storage import LocationSuggestion, MacroZoneRuleCreate, MacroZoneRuleOut, RackCreate, RackOut, RackUpdate
from app.services.placement import suggest_location

router = APIRouter(tags=["storage"])

# Справочник ячеек (4.1 п.5, 4.2 ТЗ) — заводится один раз при вводе стеллажа в
# эксплуатацию, дальше расширяется по мере роста склада. Часть
# администрирования (5.6 ТЗ) — доступ только логисту/руководителю, кладовщик
# размещает по уже готовым макрозонам, но не заводит их сам.
manage_storage = require_roles("logist")


@router.get("/racks", response_model=list[RackOut])
def list_racks(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Rack]:
    return db.query(Rack).order_by(Rack.code).all()


@router.post("/racks", response_model=RackOut, status_code=status.HTTP_201_CREATED)
def create_rack(payload: RackCreate, db: Session = Depends(get_db), user=Depends(manage_storage)) -> Rack:
    if db.query(Rack).filter(Rack.code == payload.code).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Стеллаж с таким кодом уже существует")
    rack = Rack(code=payload.code, type=payload.type, shelf_count=payload.shelf_count)
    db.add(rack)
    db.commit()
    db.refresh(rack)
    return rack


@router.patch("/racks/{rack_id}", response_model=RackOut)
def update_rack(
    rack_id: int, payload: RackUpdate, db: Session = Depends(get_db), user=Depends(manage_storage)
) -> Rack:
    rack = db.get(Rack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    if payload.code is not None and payload.code != rack.code:
        if db.query(Rack).filter(Rack.code == payload.code, Rack.id != rack_id).first():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Стеллаж с таким кодом уже существует")
        rack.code = payload.code
    if payload.type is not None:
        rack.type = payload.type
    if payload.shelf_count is not None:
        rack.shelf_count = payload.shelf_count
    if payload.is_active is not None:
        rack.is_active = payload.is_active
    db.commit()
    db.refresh(rack)
    return rack


@router.delete("/racks/{rack_id}/macro-zone-rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_macro_zone_rule(
    rack_id: int, rule_id: int, db: Session = Depends(get_db), user=Depends(manage_storage)
) -> None:
    rule = db.query(MacroZoneRule).filter(MacroZoneRule.id == rule_id, MacroZoneRule.rack_id == rack_id).first()
    if rule is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Правило не найдено")
    db.delete(rule)
    db.commit()


def _lookup_dict_id(db: Session, model, name_or_value: str | float | None, field: str) -> int | None:
    """Правило зонирования ссылается только на существующие значения
    справочников (4.2 ТЗ) — опечатка не должна тихо создавать новую запись."""
    if name_or_value is None:
        return None
    obj = db.query(model).filter_by(**{field: name_or_value}).first()
    if obj is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Значение «{name_or_value}» не найдено в справочнике")
    return obj.id


@router.get("/racks/{rack_id}/macro-zone-rules", response_model=list[MacroZoneRuleOut])
def list_macro_zone_rules(rack_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[MacroZoneRule]:
    return db.query(MacroZoneRule).filter(MacroZoneRule.rack_id == rack_id).order_by(MacroZoneRule.from_shelf).all()


@router.post("/racks/{rack_id}/macro-zone-rules", response_model=MacroZoneRuleOut, status_code=status.HTTP_201_CREATED)
def create_macro_zone_rule(
    rack_id: int,
    payload: MacroZoneRuleCreate,
    db: Session = Depends(get_db),
    user=Depends(manage_storage),
) -> MacroZoneRule:
    rack = db.get(Rack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    if payload.from_shelf > payload.to_shelf:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="«От полки» не может быть больше «До полки»")
    if payload.to_shelf > rack.shelf_count:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"На стеллаже {rack.shelf_count} полок — диапазон выходит за пределы",
        )

    rule = MacroZoneRule(
        rack_id=rack_id,
        from_shelf=payload.from_shelf,
        to_shelf=payload.to_shelf,
        material_id=_lookup_dict_id(db, Material, payload.material, "name"),
        color_id=_lookup_dict_id(db, Color, payload.color, "name"),
        thickness_id=_lookup_dict_id(db, Thickness, payload.thickness, "value_mm"),
        manufacturer_id=_lookup_dict_id(db, Manufacturer, payload.manufacturer, "name"),
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


@router.get("/storage/suggest-location", response_model=LocationSuggestion)
def suggest_location_endpoint(
    material_sku_id: int,
    width_mm: float,
    parent_id: int | None = None,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
) -> LocationSuggestion:
    """Автоподбор места хранения (4.2 ТЗ) — рекомендация, а не резервирование:
    вызывается заново при каждом подтверждении, гонки при параллельной
    работе не приводят к сбою (следующий вызов просто увидит слот занятым)."""
    sku = db.get(MaterialSku, material_sku_id)
    if sku is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Позиция материала не найдена")
    calc_settings = db.get(CalcSettings, 1)
    cells_per_strip_shelf = calc_settings.cells_per_strip_shelf if calc_settings else 10
    location = suggest_location(
        db, sku=sku, width_mm=width_mm, parent_id=parent_id, cells_per_strip_shelf=cells_per_strip_shelf
    )
    return LocationSuggestion(location_code=location)
