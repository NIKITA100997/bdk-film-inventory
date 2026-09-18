from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.part_film_restrictions import PartFilmRestriction
from app.schemas.part_film_restrictions import (
    PartFilmRestrictionCreate,
    PartFilmRestrictionOut,
    PartFilmRestrictionUpdate,
)
from app.services.part_film_restrictions import unique_restriction_code

router = APIRouter(tags=["part-film-restrictions"])

# Тот же логист/руководитель, что и остальными справочниками — отдельное
# право не заводим (см. app/api/write_off_reasons.py::manage_reasons).
manage_restrictions = require_permission("materials.manage")


@router.get("/part-film-restrictions", response_model=list[PartFilmRestrictionOut])
def list_restrictions(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[PartFilmRestriction]:
    return (
        db.query(PartFilmRestriction)
        .filter(PartFilmRestriction.is_active.is_(True))
        .order_by(PartFilmRestriction.name)
        .all()
    )


@router.post("/part-film-restrictions", response_model=PartFilmRestrictionOut, status_code=status.HTTP_201_CREATED)
def create_restriction(
    payload: PartFilmRestrictionCreate, db: Session = Depends(get_db), user=Depends(manage_restrictions)
) -> PartFilmRestriction:
    if db.query(PartFilmRestriction).filter(PartFilmRestriction.name == payload.name).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Пометка с таким названием уже есть")
    restriction = PartFilmRestriction(code=unique_restriction_code(db, payload.name), name=payload.name, is_active=True)
    db.add(restriction)
    db.commit()
    db.refresh(restriction)
    return restriction


@router.patch("/part-film-restrictions/{code}", response_model=PartFilmRestrictionOut)
def update_restriction(
    code: str, payload: PartFilmRestrictionUpdate, db: Session = Depends(get_db), user=Depends(manage_restrictions)
) -> PartFilmRestriction:
    restriction = db.get(PartFilmRestriction, code)
    if restriction is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пометка не найдена")
    if payload.name is not None:
        if db.query(PartFilmRestriction).filter(PartFilmRestriction.name == payload.name, PartFilmRestriction.code != code).first():
            raise HTTPException(status.HTTP_409_CONFLICT, "Пометка с таким названием уже есть")
        restriction.name = payload.name
    if payload.is_active is not None:
        restriction.is_active = payload.is_active
    db.commit()
    db.refresh(restriction)
    return restriction
