"""Единые остатки и журнал движений (этап 5 единой модели, слои 1–2) —
только чтение, см. services/unified_stock.py."""

from datetime import date, datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import get_current_user, get_permission_codes
from app.db.session import get_db
from app.models.areas import Area
from app.models.users import User
from app.services.unified_stock import list_lots, list_movements

router = APIRouter(prefix="/unified-stock", tags=["unified-stock"])


class LotOut(BaseModel):
    kind: str
    lot_id: int
    item_id: int | None
    item_name: str
    qty: float
    unit: str
    status: str
    area: str | None
    area_name: str | None
    location_code: str | None
    stage: str | None
    detail: str | None
    area_m2: float | None
    since: date | None
    sku_id: int | None
    part_id: int | None


class MovementOut(BaseModel):
    kind: str
    at: datetime
    event: str
    lot_id: int
    item_id: int | None
    item_name: str
    qty_delta: float | None
    unit: str
    area_name: str | None
    from_place: str | None
    to_place: str | None
    user_name: str | None
    note: str | None


def _can(user: User, *codes: str) -> bool:
    return user.is_superuser or bool(get_permission_codes(user) & set(codes))


@router.get("/lots", response_model=list[LotOut])
def get_lots(
    kind: str | None = Query(default=None),
    item_id: int | None = Query(default=None),
    area: str | None = Query(default=None),
    include_written_off: bool = Query(default=False),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[LotOut]:
    """Партии всех видов — как «Общие остатки»: плёнку видят все (как
    /stock), п/ф — с правами на учёт п/ф."""
    if not _can(user, "part_units.view", "part_units.manage"):
        kind = "plenka"
    areas = {a.code: a.name for a in db.query(Area)}
    return [
        LotOut(**{**r.__dict__, "area_name": areas.get(r.area) if r.area else None})
        for r in list_lots(db, kind=kind, item_id=item_id, area=area, include_written_off=include_written_off)
    ]


@router.get("/movements", response_model=list[MovementOut])
def get_movements(
    kind: str | None = Query(default=None),
    item_id: int | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    limit: int = Query(default=500, le=2000),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MovementOut]:
    """Движения партий всех видов одной лентой, новые сверху."""
    if not _can(user, "part_units.view", "part_units.manage"):
        kind = "plenka"
    areas = {a.code: a.name for a in db.query(Area)}
    users = {u.id: u.full_name or u.username for u in db.query(User)}
    return [
        MovementOut(
            kind=r.kind, at=r.at, event=r.event, lot_id=r.lot_id, item_id=r.item_id, item_name=r.item_name,
            qty_delta=r.qty_delta, unit=r.unit, area_name=areas.get(r.area) if r.area else None,
            from_place=r.from_place, to_place=r.to_place, user_name=users.get(r.user_id) if r.user_id else None,
            note=r.note,
        )
        for r in list_movements(db, kind=kind, item_id=item_id, date_from=date_from, date_to=date_to, limit=limit)
    ]
