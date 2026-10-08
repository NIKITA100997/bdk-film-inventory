"""Журнал движений (08.10.2026) — все виды партий одной таблицей
(services/movements.py, представление lot_movements)."""

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import get_permission_codes, require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.production import ProductionTask, ProductionTaskLine
from app.models.users import User
from app.models.write_off_reasons import WriteOffReasonEntry
from app.services import movements as mv
from app.services.components import live_item_names

router = APIRouter(prefix="/movements", tags=["movements"])
view = require_permission("reports.view")
PRICE_PERMS = {"prices.view", "prices.manage"}


class MovementOut(BaseModel):
    kind: str
    kind_label: str
    src_id: int
    lot_id: int | None
    lot_no: str | None
    item_id: int | None
    item_name: str | None
    occurred_at: datetime
    op: str
    op_label: str
    qty: float
    unit: str
    qty_m2: float | None
    amount_rub: float | None
    area: str | None
    area_name: str | None
    cell_from: str | None
    cell_to: str | None
    user_name: str | None
    task_id: int | None
    task_name: str | None
    reason: str | None
    note: str | None


class TotalOut(BaseModel):
    kind: str
    kind_label: str
    unit: str
    qty_in: float
    qty_out: float
    amount_rub: float | None
    priced: int
    rows: int


class MovementsOut(BaseModel):
    total: int
    totals: list[TotalOut]
    rows: list[MovementOut]
    show_amounts: bool


class OpOption(BaseModel):
    value: str  # «вид:код»
    label: str
    kind: str


@router.get("/ops", response_model=list[OpOption], dependencies=[Depends(view)])
def movement_ops() -> list[OpOption]:
    return [OpOption(value=f"{k}:{c}", label=label, kind=k) for k, c, label in mv.op_options()]


@router.get("", response_model=MovementsOut)
def list_movements(
    date_from: date | None = None,
    date_to: date | None = None,
    kind: list[str] | None = Query(None),
    item_id: int | None = None,
    lot: str | None = None,
    area: str | None = None,
    user_id: int | None = None,
    op: list[str] | None = Query(None),
    task_line_id: int | None = None,
    only_qty: bool = True,
    limit: int = Query(200, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(view),
) -> MovementsOut:
    """Плёнка, п/ф, материалы и готовые изделия — одной хронологией, с
    итогами (приход, расход, сумма) по виду. По умолчанию — 30 дней. Суммы
    видят те, у кого есть права на цены."""
    if date_to is None:
        date_to = date.today()
    if date_from is None:
        date_from = date_to - timedelta(days=30)
    f = mv.Filters(
        date_from=date_from, date_to=date_to, kinds=kind, item_id=item_id, lot=lot, area=area, user_id=user_id,
        ops=op, task_line_id=task_line_id, only_qty=only_qty,
    )
    show_amounts = user.is_superuser or bool(PRICE_PERMS & get_permission_codes(user))
    rows = mv.query_rows(db, f, limit, offset)
    total, sums = mv.totals(db, f)

    names = live_item_names(db, {r["item_id"] for r in rows if r["item_id"]})
    users = {u.id: u.full_name or u.username for u in db.query(User).filter(User.id.in_({r["user_id"] for r in rows}))} if rows else {}
    areas = {a.code: a.name for a in db.query(Area)}
    reasons = {r.code: r.name for r in db.query(WriteOffReasonEntry)}
    line_ids = {r["task_line_id"] for r in rows if r["task_line_id"]}
    tasks: dict[int, tuple[int, str]] = {}
    if line_ids:
        for ln, t in (
            db.query(ProductionTaskLine, ProductionTask)
            .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
            .filter(ProductionTaskLine.id.in_(line_ids))
        ):
            tasks[ln.id] = (t.id, t.name or f"Задание №{t.id}")

    def money(v):
        return float(v) if (v is not None and show_amounts) else None

    out = []
    for r in rows:
        t = tasks.get(r["task_line_id"]) if r["task_line_id"] else None
        out.append(MovementOut(
            kind=r["kind"], kind_label=mv.KIND_LABEL.get(r["kind"], r["kind"]), src_id=r["src_id"], lot_id=r["lot_id"],
            lot_no=mv.lot_no(r["kind"], r["lot_id"]), item_id=r["item_id"], item_name=names.get(r["item_id"]),
            occurred_at=r["occurred_at"], op=r["op"], op_label=mv.op_label(r["kind"], r["op"]), qty=float(r["qty"]),
            unit=r["unit"], qty_m2=float(r["qty_m2"]) if r["qty_m2"] is not None else None, amount_rub=money(r["amount_rub"]),
            area=r["area"], area_name=areas.get(r["area"]) if r["area"] else None, cell_from=r["cell_from"], cell_to=r["cell_to"],
            user_name=users.get(r["user_id"]), task_id=t[0] if t else None, task_name=t[1] if t else None,
            reason=reasons.get(r["reason"], r["reason"]) if r["reason"] else None, note=r["note"],
        ))
    return MovementsOut(
        total=total,
        totals=[TotalOut(**{**s, "kind_label": mv.KIND_LABEL.get(s["kind"], s["kind"]), "amount_rub": money(s["amount_rub"])}) for s in sums],
        rows=out,
        show_amounts=show_amounts,
    )
