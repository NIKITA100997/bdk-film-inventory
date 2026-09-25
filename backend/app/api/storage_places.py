"""Единые места хранения (этап 5 единой модели, слой 3) — стеллажи плёнки
(racks: рулонные/штрипсовые, на складах) и стеллажи п/ф (part_racks) одним
справочником и одной картой полок. Таблицы и логика размещения прежние;
здесь — общий вид и общая уникальность кодов (адрес «код-полка» однозначен
для любого вида)."""

from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import get_current_user, get_permission_codes
from app.db.session import get_db
from app.models.part_storage import PartRack
from app.models.storage import Rack, RackType, Warehouse
from app.models.users import User
from app.services.unified_stock import LotRow, list_lots

router = APIRouter(prefix="/storage-places", tags=["storage-places"])

KIND_FILM = "plenka"
KIND_PF = "pf"


class PlaceOut(BaseModel):
    kind: str  # plenka / pf
    id: int
    code: str
    type_label: str
    warehouse: str | None
    shelf_count: int
    capacity_per_shelf: int | None
    is_active: bool
    lots: int
    shelves_used: int


class CellLot(BaseModel):
    lot_id: int
    item_id: int | None
    item_name: str
    qty: float
    unit: str
    detail: str | None
    status: str


class CellOut(BaseModel):
    shelf: int
    location_code: str
    capacity: int | None
    lots: list[CellLot]


def _rack_of(location_code: str | None) -> str | None:
    """Стеллаж — адрес без номера полки: «Стеллаж 1-окно-01» → «Стеллаж 1-окно»
    (не по началу строки: «Стеллаж 1-%» зацепил бы и «Стеллаж 1-окно-…»)."""
    if not location_code or "-" not in location_code:
        return None
    return location_code.rsplit("-", 1)[0]


def _lots_by_rack(db: Session, user: User) -> dict[tuple[str, str], list[LotRow]]:
    can_pf = user.is_superuser or bool(get_permission_codes(user) & {"part_units.view", "part_units.manage", "part_storage.manage"})
    out: dict[tuple[str, str], list[LotRow]] = defaultdict(list)
    for lot in list_lots(db, kind=None if can_pf else KIND_FILM):
        rack = _rack_of(lot.location_code)
        if rack:
            out[(lot.kind, rack)].append(lot)
    return out


@router.get("", response_model=list[PlaceOut])
def list_places(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[PlaceOut]:
    lots = _lots_by_rack(db, user)
    warehouses = {w.id: w.name for w in db.query(Warehouse)}
    out: list[PlaceOut] = []
    for r in db.query(Rack).order_by(Rack.code):
        here = lots.get((KIND_FILM, r.code), [])
        out.append(
            PlaceOut(
                kind=KIND_FILM, id=r.id, code=r.code,
                type_label="Плёнка: рулонный" if r.type == RackType.ROLL else "Плёнка: штрипсовый",
                warehouse=warehouses.get(r.warehouse_id), shelf_count=r.shelf_count,
                capacity_per_shelf=(r.strip_capacity or 1) if r.type == RackType.STRIP else 1, is_active=r.is_active,
                lots=len(here), shelves_used=len({x.location_code for x in here}),
            )
        )
    for r in db.query(PartRack).order_by(PartRack.code):
        here = lots.get((KIND_PF, r.code), [])
        out.append(
            PlaceOut(
                kind=KIND_PF, id=r.id, code=r.code, type_label="П/ф", warehouse=None, shelf_count=r.shelf_count,
                capacity_per_shelf=None, is_active=r.is_active, lots=len(here), shelves_used=len({x.location_code for x in here}),
            )
        )
    return out


@router.get("/{kind}/{place_id}/cells", response_model=list[CellOut])
def place_cells(kind: str, place_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[CellOut]:
    """Карта полок стеллажа любого вида: что и сколько на каждой полке."""
    if kind == KIND_FILM:
        rack = db.get(Rack, place_id)
        capacity = ((rack.strip_capacity or 1) if rack.type == RackType.STRIP else 1) if rack else None
    elif kind == KIND_PF:
        rack = db.get(PartRack, place_id)
        capacity = None
    else:
        rack = None
    if rack is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Стеллаж не найден")
    here = _lots_by_rack(db, user).get((kind, rack.code), [])
    by_code: dict[str, list[LotRow]] = defaultdict(list)
    for lot in here:
        by_code[lot.location_code].append(lot)
    return [
        CellOut(
            shelf=shelf, location_code=f"{rack.code}-{shelf:02d}", capacity=capacity,
            lots=[
                CellLot(lot_id=x.lot_id, item_id=x.item_id, item_name=x.item_name, qty=x.qty, unit=x.unit,
                        detail=x.detail or (f"этап: {x.stage}" if x.stage else None), status=x.status)
                for x in by_code.get(f"{rack.code}-{shelf:02d}", [])
            ],
        )
        for shelf in range(1, rack.shelf_count + 1)
    ]


def code_taken_anywhere(db: Session, code: str, *, exclude_film_id: int | None = None) -> str | None:
    """Код стеллажа занят в любом виде мест хранения? Вернёт вид или None."""
    q = db.query(Rack.id).filter(func.lower(Rack.code) == code.strip().lower())
    if exclude_film_id is not None:
        q = q.filter(Rack.id != exclude_film_id)
    if q.first():
        return "плёнки"
    if db.query(PartRack.id).filter(func.lower(PartRack.code) == code.strip().lower()).first():
        return "п/ф"
    return None
