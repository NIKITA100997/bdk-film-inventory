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
from app.models.dictionaries import PartStage
from app.models.events import EventType
from app.models.part_units import PartEventType
from app.services.components import live_item_names
from app.services.unified_stock import list_lots

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
    kind: str  # plenka / pf / material / fg
    at: datetime
    event: str
    lot_id: int | None  # у материалов и готовых изделий партий нет
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
    # Учёт по сумме (08.10): сумма движения, ₽ — тем, у кого права на цены.
    amount_rub: float | None = None
    lot_no: str | None = None


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
    limit: int = Query(default=500, le=5000),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MovementOut]:
    """Движения партий всех видов одной лентой, новые сверху — из единого
    журнала (представление lot_movements, 08.10): плёнка, п/ф, материалы,
    готовые изделия. Это же и «Журнал действий». Плёнку видят все; прочие
    виды — с правами на учёт п/ф или отчёты; суммы — с правами на цены."""
    from app.services import movements as mv

    others = _can(user, "part_units.view", "part_units.manage", "reports.view")
    view_kind = {"plenka": "film"}.get(kind or "", kind)
    kinds = [view_kind] if view_kind else (None if others else ["film"])
    if not others and view_kind and view_kind != "film":
        kinds = ["film"]
    show_amounts = _can(user, "prices.view", "prices.manage")
    f = mv.Filters(
        date_from=date_from or date(2000, 1, 1), date_to=date_to or date.today(), kinds=kinds, item_id=item_id,
        only_qty=False,
    )
    rows = mv.query_rows(db, f, limit, 0)
    areas = {a.code: a.name for a in db.query(Area)}
    users = {u.id: u.full_name or u.username for u in db.query(User)}
    names = live_item_names(db, {r["item_id"] for r in rows if r["item_id"]})
    stage_ids = {r["stage_from"] for r in rows if r["stage_from"]} | {r["stage_to"] for r in rows if r["stage_to"]}
    stages = {st.id: st.name for st in db.query(PartStage).filter(PartStage.id.in_(stage_ids))} if stage_ids else {}
    line_ids = {r["task_line_id"] for r in rows if r["task_line_id"]}
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

    def code(kind_: str, op: str) -> str:
        # прежний event_code — значение перечисления («Выдача_участку»)
        try:
            if kind_ == "film":
                return EventType[op].value
            if kind_ == "pf":
                return PartEventType[op].value
        except KeyError:
            pass
        return op

    out = []
    for r in rows:
        k = r["kind"]
        out.append(MovementOut(
            kind="plenka" if k == "film" else k, at=r["occurred_at"], event=mv.op_label(k, r["op"]), lot_id=r["lot_id"],
            item_id=r["item_id"], item_name=names.get(r["item_id"], "—"),
            qty_delta=float(r["qty"]) if r["qty"] is not None else None, unit=r["unit"],
            area_name=areas.get(r["area"]) if r["area"] else None,
            from_place=r["cell_from"] or (stages.get(r["stage_from"]) if r["stage_from"] else None),
            to_place=r["cell_to"] or (stages.get(r["stage_to"]) if r["stage_to"] else None),
            user_name=users.get(r["user_id"]) if r["user_id"] else None, note=r["note"], event_code=code(k, r["op"]),
            area=r["area"], task_name=task_of_line.get(r["task_line_id"]) if r["task_line_id"] else None,
            reason_name=reasons.get(r["reason"], r["reason"]) if r["reason"] else None,
            to_length=float(r["to_length"]) if r["to_length"] is not None else None,
            amount_rub=float(r["amount_rub"]) if (show_amounts and r["amount_rub"] is not None) else None,
            lot_no=mv.lot_no(k, r["lot_id"]),
        ))
    return out
