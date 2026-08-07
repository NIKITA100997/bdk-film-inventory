from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_roles
from app.db.session import get_db
from app.models.storage import Cell, Rack, Shelf
from app.schemas.storage import CellCreate, CellOut, RackCreate, RackOut, ShelfCreate, ShelfOut

router = APIRouter(tags=["storage"])

# Справочник ячеек (4.1 п.5 ТЗ) — заводится один раз при вводе стеллажа в
# эксплуатацию, дальше расширяется по мере роста склада.
manage_storage = require_roles("admin", "kladovshchik")


@router.get("/racks", response_model=list[RackOut])
def list_racks(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Rack]:
    return db.query(Rack).order_by(Rack.code).all()


@router.post("/racks", response_model=RackOut, status_code=status.HTTP_201_CREATED)
def create_rack(payload: RackCreate, db: Session = Depends(get_db), user=Depends(manage_storage)) -> Rack:
    if db.query(Rack).filter(Rack.code == payload.code).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Стеллаж с таким кодом уже существует")
    rack = Rack(code=payload.code, type=payload.type)
    db.add(rack)
    db.commit()
    db.refresh(rack)
    return rack


@router.get("/racks/{rack_id}/shelves", response_model=list[ShelfOut])
def list_shelves(rack_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Shelf]:
    return db.query(Shelf).filter(Shelf.rack_id == rack_id).order_by(Shelf.number).all()


@router.post("/racks/{rack_id}/shelves", response_model=ShelfOut, status_code=status.HTTP_201_CREATED)
def create_shelf(rack_id: int, payload: ShelfCreate, db: Session = Depends(get_db), user=Depends(manage_storage)) -> Shelf:
    rack = db.get(Rack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    shelf = Shelf(rack_id=rack_id, number=payload.number, macro_zone=payload.macro_zone)
    db.add(shelf)
    db.commit()
    db.refresh(shelf)
    return shelf


@router.get("/shelves/{shelf_id}/cells", response_model=list[CellOut])
def list_cells(shelf_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Cell]:
    return db.query(Cell).filter(Cell.shelf_id == shelf_id).order_by(Cell.number).all()


@router.post("/shelves/{shelf_id}/cells", response_model=CellOut, status_code=status.HTTP_201_CREATED)
def create_cell(shelf_id: int, payload: CellCreate, db: Session = Depends(get_db), user=Depends(manage_storage)) -> Cell:
    shelf = db.get(Shelf, shelf_id)
    if shelf is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Полка не найдена")
    cell = Cell(shelf_id=shelf_id, number=payload.number)
    db.add(cell)
    db.commit()
    db.refresh(cell)
    return cell
