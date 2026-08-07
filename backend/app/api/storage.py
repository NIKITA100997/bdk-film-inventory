from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_roles
from app.db.session import get_db
from app.models.dictionaries import Color, Manufacturer, Material, Thickness
from app.models.storage import MacroZoneRule, Rack
from app.schemas.storage import MacroZoneRuleCreate, MacroZoneRuleOut, RackCreate, RackOut

router = APIRouter(tags=["storage"])

# Справочник ячеек (4.1 п.5, 4.2 ТЗ) — заводится один раз при вводе стеллажа в
# эксплуатацию, дальше расширяется по мере роста склада.
manage_storage = require_roles("admin", "kladovshchik")


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
