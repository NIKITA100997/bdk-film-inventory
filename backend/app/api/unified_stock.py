"""Единые остатки и журнал движений (этап 5 единой модели, слои 1–2) —
только чтение, см. services/unified_stock.py."""

from datetime import date, datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import get_current_user, get_permission_codes
from app.db.session import get_db
from app.models.areas import Area
from app.models.production import ProductionTask, ProductionTaskLine
from app.models.users import User
from app.models.write_off_reasons import WriteOffReasonEntry
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
    # Журнал действий: код события и участка — для фильтров, задание,
    # причина списания, длина после события (для исправления рулона).
    event_code: str = ""
    area: str | None = None
    task_name: str | None = None
    reason_name: str | None = None
    to_length: float | None = None


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
    """Движения партий всех видов одной лентой, новые сверху. Это же и
    «Журнал действий» — п/ф в нём видели с правом на отчёты."""
    if not _can(user, "part_units.view", "part_units.manage", "reports.view"):
        kind = "plenka"
    areas = {a.code: a.name for a in db.query(Area)}
    users = {u.id: u.full_name or u.username for u in db.query(User)}
    rows = list_movements(db, kind=kind, item_id=item_id, date_from=date_from, date_to=date_to, limit=limit)
    line_ids = {r.task_line_id for r in rows if r.task_line_id}
    task_of_line = (
        {
            ln_id: t_name
            for ln_id, t_name in db.query(ProductionTaskLine.id, ProductionTask.name)
            .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
            .filter(ProductionTaskLine.id.in_(line_ids))
        }
        if line_ids
        else {}
    )
    reasons = {r.code: r.name for r in db.query(WriteOffReasonEntry)}
    return [
        MovementOut(
            kind=r.kind, at=r.at, event=r.event, lot_id=r.lot_id, item_id=r.item_id, item_name=r.item_name,
            qty_delta=r.qty_delta, unit=r.unit, area_name=areas.get(r.area) if r.area else None,
            from_place=r.from_place, to_place=r.to_place, user_name=users.get(r.user_id) if r.user_id else None,
            note=r.note, event_code=r.event_code, area=r.area,
            task_name=task_of_line.get(r.task_line_id) if r.task_line_id else None,
            reason_name=reasons.get(r.reason_code) if r.reason_code else None, to_length=r.to_length,
        )
        for r in rows
    ]
