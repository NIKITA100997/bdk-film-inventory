from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.dictionaries import Part
from app.models.part_units import PartUnit, PartUnitEvent, PartUnitStatus
from app.models.users import User
from app.schemas.part_units import PartUnitCreate, PartUnitEventOut, PartUnitIssue, PartUnitOut, PartUnitPlace, PartUnitWriteOff
from app.services.part_units import issue_part_unit, mint_part_unit, place_part_unit, write_off_part_unit

router = APIRouter(prefix="/part-units", tags=["part-units"])

manage_part_units = require_permission("part_units.manage")
view_part_units = require_permission("part_units.manage", "part_units.view")


def _part_unit_out(unit: PartUnit) -> PartUnitOut:
    return PartUnitOut(
        id=unit.id,
        parent_id=unit.parent_id,
        part_id=unit.part_id,
        part_name=unit.part.name,
        quantity_pieces=float(unit.quantity_pieces),
        stage_id=unit.stage_id,
        stage_name=unit.stage.name,
        status=unit.status,
        area=unit.area,
        location_code=unit.location_code,
        production_task_line_id=unit.production_task_line_id,
        note=unit.note,
        created_by=unit.created_by,
        created_at=unit.created_at,
        updated_at=unit.updated_at,
    )


@router.get("", response_model=list[PartUnitOut])
def list_part_units(
    part_id: int | None = None,
    area: str | None = None,
    status_: PartUnitStatus | None = None,
    stage_id: int | None = None,
    production_task_line_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(view_part_units),
) -> list[PartUnitOut]:
    query = db.query(PartUnit)
    if part_id is not None:
        query = query.filter(PartUnit.part_id == part_id)
    if area is not None:
        query = query.filter(PartUnit.area == area)
    if status_ is not None:
        query = query.filter(PartUnit.status == status_)
    if stage_id is not None:
        query = query.filter(PartUnit.stage_id == stage_id)
    if production_task_line_id is not None:
        query = query.filter(PartUnit.production_task_line_id == production_task_line_id)
    units = query.order_by(PartUnit.created_at.desc()).all()
    return [_part_unit_out(u) for u in units]


@router.post("", response_model=PartUnitOut, status_code=status.HTTP_201_CREATED)
def create_part_unit(
    payload: PartUnitCreate, db: Session = Depends(get_db), user: User = Depends(manage_part_units)
) -> PartUnitOut:
    part = db.get(Part, payload.part_id)
    if part is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Деталь не найдена")
    try:
        unit = mint_part_unit(
            db,
            part=part,
            quantity_pieces=payload.quantity_pieces,
            user_id=user.id,
            production_task_line_id=payload.production_task_line_id,
            issue_to_area=payload.issue_to_area,
            note=payload.note,
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    db.refresh(unit)
    return _part_unit_out(unit)


@router.post("/{unit_id}/issue", response_model=PartUnitOut)
def issue_part_unit_to_area(
    unit_id: int, payload: PartUnitIssue, db: Session = Depends(get_db), user: User = Depends(manage_part_units)
) -> PartUnitOut:
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    try:
        issue_part_unit(db, unit=unit, area=payload.area, user_id=user.id)
    except ValueError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    db.commit()
    db.refresh(unit)
    return _part_unit_out(unit)


@router.patch("/{unit_id}/place", response_model=PartUnitOut)
def place_part_unit_endpoint(
    unit_id: int, payload: PartUnitPlace, db: Session = Depends(get_db), user: User = Depends(manage_part_units)
) -> PartUnitOut:
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    try:
        place_part_unit(db, unit=unit, location_code=payload.location_code, user_id=user.id)
    except ValueError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    db.commit()
    db.refresh(unit)
    return _part_unit_out(unit)


@router.post("/{unit_id}/write-off", response_model=PartUnitOut)
def write_off_part_unit_endpoint(
    unit_id: int, payload: PartUnitWriteOff, db: Session = Depends(get_db), user: User = Depends(manage_part_units)
) -> PartUnitOut:
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    try:
        target = write_off_part_unit(
            db, unit=unit, quantity_pieces=payload.quantity_pieces, reason=payload.reason, user_id=user.id, note=payload.note
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    db.commit()
    db.refresh(target)
    return _part_unit_out(target)


@router.get("/{unit_id}/events", response_model=list[PartUnitEventOut])
def list_part_unit_events(
    unit_id: int, db: Session = Depends(get_db), user: User = Depends(view_part_units)
) -> list[PartUnitEvent]:
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    return (
        db.query(PartUnitEvent)
        .filter(PartUnitEvent.part_unit_id == unit_id)
        .order_by(PartUnitEvent.occurred_at.desc())
        .all()
    )
