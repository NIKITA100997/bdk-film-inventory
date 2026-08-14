"""Администрирование участков (раздел про адаптацию под планшет — "нужно
добавить администрирование участков, какие есть и т.п."). Тот же логист,
что управляет пользователями/ролями (`users.manage`), управляет и этим —
участки такая же орг-структура администрирования, отдельного права не
заводим."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.schemas.areas import AreaCreate, AreaOut, AreaUpdate
from app.services.areas import unique_area_code

router = APIRouter(tags=["areas"])

manage_areas = require_permission("users.manage")


@router.get("/areas", response_model=list[AreaOut])
def list_areas(db: Session = Depends(get_db), user=Depends(manage_areas)) -> list[Area]:
    return db.query(Area).order_by(Area.name).all()


@router.post("/areas", response_model=AreaOut, status_code=status.HTTP_201_CREATED)
def create_area(payload: AreaCreate, db: Session = Depends(get_db), user=Depends(manage_areas)) -> Area:
    if db.query(Area).filter(Area.name == payload.name).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Участок с таким названием уже есть")
    area = Area(code=unique_area_code(db, payload.name), name=payload.name, is_active=True)
    db.add(area)
    db.commit()
    db.refresh(area)
    return area


@router.patch("/areas/{code}", response_model=AreaOut)
def update_area(code: str, payload: AreaUpdate, db: Session = Depends(get_db), user=Depends(manage_areas)) -> Area:
    area = db.get(Area, code)
    if area is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Участок не найден")
    if payload.name is not None:
        if db.query(Area).filter(Area.name == payload.name, Area.code != code).first():
            raise HTTPException(status.HTTP_409_CONFLICT, "Участок с таким названием уже есть")
        area.name = payload.name
    if payload.is_active is not None:
        area.is_active = payload.is_active
    db.commit()
    db.refresh(area)
    return area
