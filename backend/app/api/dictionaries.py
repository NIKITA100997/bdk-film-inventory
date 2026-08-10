from fastapi import APIRouter, Depends, HTTPException, status
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
    MaterialSkuCreate,
    MaterialSkuOut,
    MaterialSkuUpdate,
    ThicknessOut,
    ThicknessUpdate,
)
from app.services.dict_admin import find_fuzzy_duplicates
from app.services.dictionaries import find_or_create_sku

router = APIRouter(tags=["dictionaries"])

manage_dicts = require_roles("logist")


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


@router.post("/material-skus", response_model=MaterialSkuOut, status_code=status.HTTP_201_CREATED)
def create_material_sku(
    payload: MaterialSkuCreate,
    db: Session = Depends(get_db),
    user=Depends(require_roles("operator_sklada", "logist")),
) -> MaterialSku:
    """Голая позиция без физической единицы (8.5 раздел бэклога доработок)
    — завести номенклатуру заранее, до фактической поставки."""
    sku = find_or_create_sku(
        db, material=payload.material, color=payload.color, thickness=payload.thickness, manufacturer=payload.manufacturer
    )
    if payload.supplier_code is not None:
        sku.supplier_code = payload.supplier_code
    if payload.native_width_mm is not None:
        sku.native_width_mm = payload.native_width_mm
    db.commit()
    db.refresh(sku)
    return sku


def _skus_query(db: Session):
    return db.query(MaterialSku).options(
        joinedload(MaterialSku.material),
        joinedload(MaterialSku.color),
        joinedload(MaterialSku.thickness),
        joinedload(MaterialSku.manufacturer),
    )


@router.get("/material-skus", response_model=list[MaterialSkuOut])
def list_material_skus(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[MaterialSku]:
    return _skus_query(db).filter(MaterialSku.is_active).all()


@router.get("/material-skus/all", response_model=list[MaterialSkuOut])
def list_all_material_skus(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[MaterialSku]:
    """Номенклатура целиком, включая архивные (1 раздел бэклога доработок,
    пояснение по разделу 6 — это и есть каталог позиций, справочники
    материала/цвета/толщины/производителя — только его 4 составляющих)."""
    return _skus_query(db).all()


@router.patch("/material-skus/{sku_id}", response_model=MaterialSkuOut)
def update_material_sku(
    sku_id: int, payload: MaterialSkuUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> MaterialSku:
    sku = db.get(MaterialSku, sku_id)
    if sku is None:
        raise HTTPException(404, "Позиция не найдена")
    if payload.supplier_code is not None:
        sku.supplier_code = payload.supplier_code
    if payload.native_width_mm is not None:
        sku.native_width_mm = payload.native_width_mm
    if payload.is_active is not None:
        sku.is_active = payload.is_active
    db.commit()
    db.refresh(sku)
    return _skus_query(db).filter(MaterialSku.id == sku_id).first()
