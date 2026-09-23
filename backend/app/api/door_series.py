from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.door_series import DoorSeries
from app.schemas.door_series import DoorSeriesCreate, DoorSeriesOut, DoorSeriesUpdate

router = APIRouter(prefix="/door-series", tags=["door-series"])

# Тот же начальник производства, что ведёт справочник деталей и линии цеха.
manage_series = require_permission("production_tasks.manage")
view_series = require_permission("production_tasks.manage", "production_tasks.view")


def _name_taken(db: Session, name: str, exclude_id: int | None = None) -> bool:
    query = db.query(DoorSeries.id).filter(DoorSeries.name == name)
    if exclude_id is not None:
        query = query.filter(DoorSeries.id != exclude_id)
    return query.first() is not None


@router.get("", response_model=list[DoorSeriesOut])
def list_door_series(db: Session = Depends(get_db), user=Depends(view_series)) -> list[DoorSeries]:
    return db.query(DoorSeries).order_by(DoorSeries.name).all()


@router.post("", response_model=DoorSeriesOut, status_code=status.HTTP_201_CREATED)
def create_door_series(
    payload: DoorSeriesCreate, db: Session = Depends(get_db), user=Depends(manage_series)
) -> DoorSeries:
    name = payload.name.strip()
    if _name_taken(db, name):
        raise HTTPException(status.HTTP_409_CONFLICT, "Серия с таким названием уже есть")
    series = DoorSeries(**payload.model_dump(exclude={"name"}), name=name, is_active=True)
    db.add(series)
    db.commit()
    db.refresh(series)
    return series


@router.patch("/{series_id}", response_model=DoorSeriesOut)
def update_door_series(
    series_id: int, payload: DoorSeriesUpdate, db: Session = Depends(get_db), user=Depends(manage_series)
) -> DoorSeries:
    series = db.get(DoorSeries, series_id)
    if series is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Серия не найдена")
    # model_fields_set, а не "is not None" — иначе программу фрезеровки
    # нельзя было бы очистить (None неотличим от "поле не передали").
    changes = {k: getattr(payload, k) for k in payload.model_fields_set}
    if "name" in changes:
        if changes["name"] is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Название не может быть пустым")
        changes["name"] = changes["name"].strip()
        if _name_taken(db, changes["name"], exclude_id=series_id):
            raise HTTPException(status.HTTP_409_CONFLICT, "Серия с таким названием уже есть")
    for field in ("frame_thickness_mm", "panel_mdf_thickness_mm", "edge_type", "has_glass", "has_moulding", "needs_lock_milling", "is_active"):
        if field in changes and changes[field] is None:
            del changes[field]
    for field, value in changes.items():
        setattr(series, field, value)
    db.commit()
    db.refresh(series)
    return series
