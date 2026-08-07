from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session, joinedload

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.dictionaries import Color, Manufacturer, Material, MaterialSku, Thickness
from app.schemas.dictionaries import ColorOut, ManufacturerOut, MaterialOut, MaterialSkuOut, ThicknessOut

router = APIRouter(tags=["dictionaries"])


@router.get("/materials", response_model=list[MaterialOut])
def list_materials(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Material]:
    return db.query(Material).filter(Material.is_active).order_by(Material.name).all()


@router.get("/colors", response_model=list[ColorOut])
def list_colors(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Color]:
    return db.query(Color).filter(Color.is_active).order_by(Color.name).all()


@router.get("/thicknesses", response_model=list[ThicknessOut])
def list_thicknesses(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Thickness]:
    return db.query(Thickness).filter(Thickness.is_active).order_by(Thickness.value_mm).all()


@router.get("/manufacturers", response_model=list[ManufacturerOut])
def list_manufacturers(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Manufacturer]:
    return db.query(Manufacturer).filter(Manufacturer.is_active).order_by(Manufacturer.name).all()


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
