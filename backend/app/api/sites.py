"""Администрирование площадок (раздел про площадки) — то же зеркало, что
areas.py: список открыт любому авторизованному (нужен на "Выдаче"/в
администрировании участков для выбора площадки), запись — за users.manage,
той же орг-структурной группой прав, что участки/пользователи/роли."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.sites import Site
from app.models.storage import Warehouse
from app.schemas.sites import SiteCreate, SiteOut, SiteUpdate

router = APIRouter(tags=["sites"])

manage_sites = require_permission("users.manage")


@router.get("/sites", response_model=list[SiteOut])
def list_sites(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Site]:
    return db.query(Site).order_by(Site.name).all()


def _validate_warehouse_id(db: Session, warehouse_id: int) -> None:
    if db.get(Warehouse, warehouse_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Склад не найден")


@router.post("/sites", response_model=SiteOut, status_code=status.HTTP_201_CREATED)
def create_site(payload: SiteCreate, db: Session = Depends(get_db), user=Depends(manage_sites)) -> Site:
    if db.query(Site).filter(Site.name == payload.name).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Площадка с таким названием уже есть")
    _validate_warehouse_id(db, payload.warehouse_id)
    site = Site(name=payload.name, warehouse_id=payload.warehouse_id, is_active=True)
    db.add(site)
    db.commit()
    db.refresh(site)
    return site


@router.patch("/sites/{site_id}", response_model=SiteOut)
def update_site(site_id: int, payload: SiteUpdate, db: Session = Depends(get_db), user=Depends(manage_sites)) -> Site:
    site = db.get(Site, site_id)
    if site is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Площадка не найдена")
    if payload.name is not None:
        if db.query(Site).filter(Site.name == payload.name, Site.id != site_id).first():
            raise HTTPException(status.HTTP_409_CONFLICT, "Площадка с таким названием уже есть")
        site.name = payload.name
    if payload.warehouse_id is not None:
        _validate_warehouse_id(db, payload.warehouse_id)
        site.warehouse_id = payload.warehouse_id
    if payload.is_active is not None:
        site.is_active = payload.is_active
    db.commit()
    db.refresh(site)
    return site
