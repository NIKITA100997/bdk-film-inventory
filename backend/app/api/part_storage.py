from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.part_units import _part_unit_out
from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.part_storage import PartRack
from app.models.part_units import PartUnit, PartUnitStatus
from app.schemas.part_storage import PartRackCreate, PartRackOccupancyCellOut, PartRackOut

router = APIRouter(prefix="/part-racks", tags=["part-storage"])

manage_part_storage = require_permission("part_storage.manage")


@router.get("", response_model=list[PartRackOut])
def list_part_racks(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[PartRack]:
    return db.query(PartRack).order_by(PartRack.code).all()


@router.post("", response_model=PartRackOut, status_code=status.HTTP_201_CREATED)
def create_part_rack(payload: PartRackCreate, db: Session = Depends(get_db), user=Depends(manage_part_storage)) -> PartRack:
    if db.query(PartRack).filter(PartRack.code == payload.code).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Стеллаж с таким кодом уже существует")
    rack = PartRack(code=payload.code, shelf_count=payload.shelf_count)
    db.add(rack)
    db.commit()
    db.refresh(rack)
    return rack


@router.get("/{rack_id}/occupancy", response_model=list[PartRackOccupancyCellOut])
def part_rack_occupancy(rack_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[PartRackOccupancyCellOut]:
    """Схема стеллажа п/ф (зеркалит rack_occupancy у плёнки, storage.py) —
    сетка полок с тем, что на каждой физически сейчас."""
    rack = db.get(PartRack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")

    units = (
        db.query(PartUnit)
        .filter(
            PartUnit.location_code.like(f"{rack.code}-%"),
            PartUnit.status == PartUnitStatus.NA_KHRANENII,
        )
        .order_by(PartUnit.id)
        .all()
    )
    units_by_code: dict[str, list[PartUnit]] = defaultdict(list)
    for u in units:
        units_by_code[u.location_code].append(u)

    cells: list[PartRackOccupancyCellOut] = []
    for shelf in range(1, rack.shelf_count + 1):
        code = f"{rack.code}-{shelf:02d}"
        cells.append(
            PartRackOccupancyCellOut(shelf=shelf, location_code=code, units=[_part_unit_out(u) for u in units_by_code.get(code, [])])
        )
    return cells
