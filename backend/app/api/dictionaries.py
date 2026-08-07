from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.core.security import get_current_user, require_roles
from app.db.session import get_db
from app.models.dictionaries import Color, Manufacturer, Material, MaterialSku, Thickness
from app.schemas.dictionaries import (
    ColorOut,
    DictEntryUpdate,
    DuplicateCandidateOut,
    ManufacturerOut,
    MaterialOut,
    MaterialSkuOut,
    ThicknessOut,
    ThicknessUpdate,
)
from app.services.dict_admin import find_fuzzy_duplicates

router = APIRouter(tags=["dictionaries"])

manage_dicts = require_roles("admin", "kladovshchik")


def _update_name_entry(db: Session, model, entry_id: int, payload: DictEntryUpdate):
    obj = db.get(model, entry_id)
    if obj is None:
        raise HTTPException(404, "Значение справочника не найдено")
    if payload.name is not None:
        obj.name = payload.name
    if payload.is_active is not None:
        obj.is_active = payload.is_active
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Такое значение уже есть в справочнике")
    db.refresh(obj)
    return obj


def _duplicates_for(db: Session, model) -> list:
    entries = [(e.id, e.name) for e in db.query(model).all()]
    return find_fuzzy_duplicates(entries)


@router.get("/materials", response_model=list[MaterialOut])
def list_materials(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Material]:
    return db.query(Material).filter(Material.is_active).order_by(Material.name).all()


@router.get("/materials/all", response_model=list[MaterialOut])
def list_all_materials(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[Material]:
    return db.query(Material).order_by(Material.name).all()


@router.get("/materials/duplicates", response_model=list[DuplicateCandidateOut])
def material_duplicates(db: Session = Depends(get_db), user=Depends(manage_dicts)):
    return _duplicates_for(db, Material)


@router.patch("/materials/{material_id}", response_model=MaterialOut)
def update_material(
    material_id: int, payload: DictEntryUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> Material:
    return _update_name_entry(db, Material, material_id, payload)


@router.get("/colors", response_model=list[ColorOut])
def list_colors(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Color]:
    return db.query(Color).filter(Color.is_active).order_by(Color.name).all()


@router.get("/colors/all", response_model=list[ColorOut])
def list_all_colors(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[Color]:
    return db.query(Color).order_by(Color.name).all()


@router.get("/colors/duplicates", response_model=list[DuplicateCandidateOut])
def color_duplicates(db: Session = Depends(get_db), user=Depends(manage_dicts)):
    return _duplicates_for(db, Color)


@router.patch("/colors/{color_id}", response_model=ColorOut)
def update_color(
    color_id: int, payload: DictEntryUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> Color:
    return _update_name_entry(db, Color, color_id, payload)


@router.get("/thicknesses", response_model=list[ThicknessOut])
def list_thicknesses(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Thickness]:
    return db.query(Thickness).filter(Thickness.is_active).order_by(Thickness.value_mm).all()


@router.get("/thicknesses/all", response_model=list[ThicknessOut])
def list_all_thicknesses(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[Thickness]:
    return db.query(Thickness).order_by(Thickness.value_mm).all()


@router.patch("/thicknesses/{thickness_id}", response_model=ThicknessOut)
def update_thickness(
    thickness_id: int, payload: ThicknessUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> Thickness:
    obj = db.get(Thickness, thickness_id)
    if obj is None:
        raise HTTPException(404, "Значение справочника не найдено")
    if payload.value_mm is not None:
        obj.value_mm = payload.value_mm
    if payload.is_active is not None:
        obj.is_active = payload.is_active
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Такое значение уже есть в справочнике")
    db.refresh(obj)
    return obj


@router.get("/manufacturers", response_model=list[ManufacturerOut])
def list_manufacturers(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Manufacturer]:
    return db.query(Manufacturer).filter(Manufacturer.is_active).order_by(Manufacturer.name).all()


@router.get("/manufacturers/all", response_model=list[ManufacturerOut])
def list_all_manufacturers(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[Manufacturer]:
    return db.query(Manufacturer).order_by(Manufacturer.name).all()


@router.get("/manufacturers/duplicates", response_model=list[DuplicateCandidateOut])
def manufacturer_duplicates(db: Session = Depends(get_db), user=Depends(manage_dicts)):
    return _duplicates_for(db, Manufacturer)


@router.patch("/manufacturers/{manufacturer_id}", response_model=ManufacturerOut)
def update_manufacturer(
    manufacturer_id: int, payload: DictEntryUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> Manufacturer:
    return _update_name_entry(db, Manufacturer, manufacturer_id, payload)


@router.get("/material-skus", response_model=list[MaterialSkuOut])
def list_material_skus(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[MaterialSku]:
    return (
        db.query(MaterialSku)
        .options(
            joinedload(MaterialSku.material),
            joinedload(MaterialSku.color),
            joinedload(MaterialSku.thickness),
            joinedload(MaterialSku.manufacturer),
        )
        .filter(MaterialSku.is_active)
        .all()
    )
