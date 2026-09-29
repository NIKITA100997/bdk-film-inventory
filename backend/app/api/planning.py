"""Планировщик производства: сетка «участки × рабочие дни» по слотам плана,
перенос и деление слотов, строки без плана (services/planning.py)."""

from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import PartStage
from app.models.production import (
    PlanSlot,
    ProductionTask,
    ProductionTaskLine,
    ProductionTaskLineAssignment,
    ProductionTaskLineReport,
)
from app.models.production_orders import ProductionOrder
from app.models.sites import Site
from app.models.users import User
from app.services.planning import check_move, is_workday, shift_following, to_workday

# Поле моделей называется date — тип под другим именем, чтобы не перекрывать.
Day = date

router = APIRouter(prefix="/planning", tags=["planning"])

view = require_permission("production_tasks.manage", "production_tasks.view", "production_tasks.report")
manage = require_permission("production_tasks.manage")


def _good(db: Session, line_ids: list[int]) -> dict[int, float]:
    if not line_ids:
        return {}
    return {
        lid: float(g)
        for lid, g in db.query(ProductionTaskLineReport.task_line_id, func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
        .filter(ProductionTaskLineReport.task_line_id.in_(line_ids), ProductionTaskLineReport.counts_toward_line.is_(True))
        .group_by(ProductionTaskLineReport.task_line_id)
    }


class AreaOut(BaseModel):
    code: str
    name: str
    site: str | None
    # Мощность в день (штук в смену × смен); None — не задана.
    capacity: float | None = None


class CellOut(BaseModel):
    area: str
    date: Day
    quantity: float
    lines: int
    overdue: float  # прошедший день: запланировано и не сделано


class BacklogOut(BaseModel):
    area: str
    lines: int
    quantity: float


class BoardOut(BaseModel):
    days: list[date]
    areas: list[AreaOut]
    cells: list[CellOut]
    backlog: list[BacklogOut]  # открытые строки без плана


def _active_lines(db: Session) -> list[tuple[ProductionTaskLine, ProductionTask]]:
    return [
        (ln, t)
        for ln, t in db.query(ProductionTaskLine, ProductionTask)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTask.is_active.is_(True))
        if not (ln.is_closed or ln.production_closed)
    ]


@router.get("/board", response_model=BoardOut)
def board(
    date_from: date | None = None,
    date_to: date | None = None,
    site_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(view),
) -> BoardOut:
    start = to_workday(date_from or date.today())
    end = date_to or start + timedelta(days=20)
    days = [start + timedelta(days=i) for i in range((end - start).days + 1) if is_workday(start + timedelta(days=i))]
    sites = {s.id: s.name for s in db.query(Site)}
    areas_all = {a.code: a for a in db.query(Area).filter(Area.is_active.is_(True))}
    pairs = _active_lines(db)
    line_ids = [ln.id for ln, _ in pairs]
    area_of = {ln.id: t.area for ln, t in pairs}
    good = _good(db, line_ids)
    slots = db.query(PlanSlot).filter(PlanSlot.task_line_id.in_(line_ids)).all() if line_ids else []
    today = date.today()

    cells: dict[tuple[str, date], CellOut] = {}
    planned_by_line: dict[int, float] = defaultdict(float)
    past_by_line: dict[int, list[PlanSlot]] = defaultdict(list)
    for s in slots:
        planned_by_line[s.task_line_id] += float(s.quantity)
        if s.date < today:
            past_by_line[s.task_line_id].append(s)
    # Просрочено: сделанное закрывает сначала самые ранние слоты строки.
    overdue_by_slot: dict[int, float] = {}
    for lid, ss in past_by_line.items():
        done = good.get(lid, 0.0)
        for s in sorted(ss, key=lambda x: x.date):
            take = min(done, float(s.quantity))
            done -= take
            overdue_by_slot[s.id] = float(s.quantity) - take
    for s in slots:
        area = area_of[s.task_line_id]
        d = s.date if s.date >= start else start  # просроченное — в первый день сетки
        if d > end:
            continue
        key = (area, d)
        c = cells.get(key) or CellOut(area=area, date=d, quantity=0, lines=0, overdue=0)
        c.quantity = round(c.quantity + float(s.quantity), 2)
        c.lines += 1
        c.overdue = round(c.overdue + overdue_by_slot.get(s.id, 0.0), 2)
        cells[key] = c
    backlog: dict[str, BacklogOut] = {}
    for ln, t in pairs:
        left = float(ln.quantity_pieces) - good.get(ln.id, 0.0) - planned_by_line.get(ln.id, 0.0)
        if ln.id in planned_by_line or left <= 0:
            continue
        b = backlog.get(t.area) or BacklogOut(area=t.area, lines=0, quantity=0)
        b.lines += 1
        b.quantity = round(b.quantity + left, 2)
        backlog[t.area] = b
    used = {a for a, _ in cells} | set(backlog)
    areas = [
        AreaOut(
            code=a.code, name=a.name, site=sites.get(a.site_id),
            capacity=round(float(a.capacity_per_shift) * (a.shifts_per_day or 1), 2) if a.capacity_per_shift else None,
        )
        for a in sorted(areas_all.values(), key=lambda a: (sites.get(a.site_id) or "я", a.name))
        if a.code in used and (site_id is None or a.site_id == site_id)
    ]
    keep = {a.code for a in areas}
    return BoardOut(
        days=days, areas=areas, cells=[c for c in cells.values() if c.area in keep],
        backlog=[b for b in backlog.values() if b.area in keep],
    )


class SlotOut(BaseModel):
    id: int | None  # None — строка без плана
    date: Day | None
    quantity: float
    auto: bool
    overdue: bool
    task_line_id: int
    task_id: int
    task_name: str
    area: str
    what: str  # деталь / позиция
    operation: str | None
    line_plan: float
    line_done: float
    order_id: int | None
    order_name: str | None
    ship_date: date | None


@router.get("/slots", response_model=list[SlotOut])
def slots(
    area: str,
    date_from: date | None = None,
    date_to: date | None = None,
    unplanned: bool = False,
    include_earlier: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(view),
) -> list[SlotOut]:
    """Слоты участка за период (просроченные — в первый день) или строки без плана."""
    pairs = [(ln, t) for ln, t in _active_lines(db) if t.area == area]
    line_ids = [ln.id for ln, _ in pairs]
    good = _good(db, line_ids)
    orders = {o.id: o for o in db.query(ProductionOrder).filter(ProductionOrder.id.in_({t.production_order_id for _, t in pairs if t.production_order_id}))}
    stages = {s.id: s.name for s in db.query(PartStage).filter(PartStage.id.in_({ln.part_stage_id for ln, _ in pairs if ln.part_stage_id}))}
    by_line = {ln.id: (ln, t) for ln, t in pairs}
    today = date.today()

    def out(ln: ProductionTaskLine, t: ProductionTask, s: PlanSlot | None, qty: float) -> SlotOut:
        o = orders.get(t.production_order_id)
        return SlotOut(
            id=s.id if s else None, date=s.date if s else None, quantity=round(qty, 2), auto=s.auto if s else False,
            overdue=bool(s and s.date < today and good.get(ln.id, 0.0) < float(ln.quantity_pieces)),
            task_line_id=ln.id, task_id=t.id, task_name=t.name or f"Задание №{t.id}", area=t.area,
            what=ln.part_name or "—", operation=stages.get(ln.part_stage_id), line_plan=float(ln.quantity_pieces),
            line_done=good.get(ln.id, 0.0), order_id=o.id if o else None, order_name=o.name if o else None,
            ship_date=o.ship_date if o else None,
        )

    all_slots = db.query(PlanSlot).filter(PlanSlot.task_line_id.in_(line_ids)).all() if line_ids else []
    if unplanned:
        planned = {s.task_line_id for s in all_slots}
        res = []
        for ln, t in pairs:
            left = float(ln.quantity_pieces) - good.get(ln.id, 0.0)
            if ln.id not in planned and left > 0:
                res.append(out(ln, t, None, left))
        return res
    start = date_from or today
    end = date_to or start
    res = []
    for s in sorted(all_slots, key=lambda x: (x.date, x.id)):
        # Первая колонка сетки показывает и более ранние (просроченные) слоты.
        if not (start <= s.date <= end or (include_earlier and s.date < start)):
            continue
        ln, t = by_line[s.task_line_id]
        res.append(out(ln, t, s, float(s.quantity)))
    return res


class SlotPatch(BaseModel):
    date: Day | None = None
    quantity: float | None = Field(default=None, gt=0)
    shift_next: bool = False  # сдвинуть следующие этапы, если встали раньше


def _get_slot(db: Session, slot_id: int) -> PlanSlot:
    s = db.get(PlanSlot, slot_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Слот плана не найден")
    return s


@router.patch("/slots/{slot_id}", status_code=status.HTTP_204_NO_CONTENT)
def patch_slot(slot_id: int, payload: SlotPatch, db: Session = Depends(get_db), user: User = Depends(manage)) -> None:
    """Перенести слот на другой день / поменять количество — становится
    ручным, пересчёт сроков его не трогает."""
    s = _get_slot(db, slot_id)
    if payload.date is not None:
        s.date = to_workday(payload.date)
    if payload.quantity is not None:
        s.quantity = payload.quantity
    s.auto = False
    db.flush()
    if payload.shift_next:
        shift_following(db, {s.task_line_id})
    db.commit()


class SlotSplit(BaseModel):
    date: Day
    quantity: float = Field(gt=0)
    shift_next: bool = False


@router.post("/slots/{slot_id}/split", status_code=status.HTTP_204_NO_CONTENT)
def split_slot(slot_id: int, payload: SlotSplit, db: Session = Depends(get_db), user: User = Depends(manage)) -> None:
    """Отделить часть штук слота на другой день (оба слота — ручные)."""
    s = _get_slot(db, slot_id)
    if payload.quantity >= float(s.quantity):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Отделить можно меньше {float(s.quantity):g} шт — иначе просто перенесите")
    s.quantity = round(float(s.quantity) - payload.quantity, 2)
    s.auto = False
    db.add(PlanSlot(task_line_id=s.task_line_id, date=to_workday(payload.date), quantity=payload.quantity, auto=False, created_by=user.id))
    db.flush()
    if payload.shift_next:
        shift_following(db, {s.task_line_id})
    db.commit()


class LinePlanIn(BaseModel):
    date: Day
    quantity: float = Field(gt=0)


class LineDayOut(BaseModel):
    date: Day
    quantity: float  # по плану на этот день
    assigned: float  # уже распределено по линиям на этот день


@router.get("/lines/{line_id}/days", response_model=list[LineDayOut])
def line_days(line_id: int, db: Session = Depends(get_db), user: User = Depends(view)) -> list[LineDayOut]:
    """Дни строки задания в планировщике — из них мастер выбирает день при
    распределении по линиям (день работы задаётся только в планировщике).
    Пусто — строка не в плане."""
    plan: dict[date, float] = defaultdict(float)
    for s in db.query(PlanSlot).filter(PlanSlot.task_line_id == line_id):
        plan[s.date] += float(s.quantity)
    assigned: dict[date, float] = defaultdict(float)
    for a in db.query(ProductionTaskLineAssignment).filter(ProductionTaskLineAssignment.task_line_id == line_id):
        assigned[a.date] += float(a.quantity_pieces)
    return [LineDayOut(date=d, quantity=round(q, 2), assigned=round(assigned.get(d, 0.0), 2)) for d, q in sorted(plan.items())]


@router.post("/lines/{line_id}/slots", status_code=status.HTTP_201_CREATED)
def plan_line(line_id: int, payload: LinePlanIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> dict:
    """Поставить в план строку без плана (ручной слот)."""
    ln = db.get(ProductionTaskLine, line_id)
    if ln is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Строка задания не найдена")
    s = PlanSlot(task_line_id=ln.id, date=to_workday(payload.date), quantity=payload.quantity, auto=False, created_by=user.id)
    db.add(s)
    db.commit()
    return {"id": s.id}


class CellMoveIn(BaseModel):
    area: str
    from_date: Day
    to_date: Day
    include_earlier: bool = False  # первая колонка сетки — с просроченными
    shift_next: bool = False


@router.post("/cells/move")
def move_cell(payload: CellMoveIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> dict:
    """Перетащили клетку «участок × день» на другой день: все её слоты туда
    (становятся ручными). Сделанное не трогаем — двигаем план."""
    to = to_workday(payload.to_date)
    line_ids = [ln.id for ln, t in _active_lines(db) if t.area == payload.area]
    if not line_ids:
        return {"moved": 0}
    q = db.query(PlanSlot).filter(PlanSlot.task_line_id.in_(line_ids))
    q = q.filter(PlanSlot.date <= payload.from_date) if payload.include_earlier else q.filter(PlanSlot.date == payload.from_date)
    moved, lines = 0, set()
    for s in q:
        s.date = to
        s.auto = False
        moved += 1
        lines.add(s.task_line_id)
    db.flush()
    if payload.shift_next and lines:
        shift_following(db, lines)
    db.commit()
    return {"moved": moved}


class MoveCheckIn(BaseModel):
    to_date: Day
    slot_id: int | None = None  # перенос одного слота
    split: bool = False  # деление: часть слота slot_id — на to_date
    cell: CellMoveIn | None = None  # перенос клетки целиком


class ConflictOut(BaseModel):
    what: str
    operation: str | None
    area_name: str
    relation: str  # next | prev
    start: Day
    need: Day


class ShiftOut(BaseModel):
    what: str
    operation: str | None
    area_name: str
    before: Day
    after: Day


class MoveCheckOut(BaseModel):
    conflicts: list[ConflictOut]
    will_shift: list[ShiftOut]  # что сдвинется при «сдвинуть следующие этапы»


@router.post("/check-move", response_model=MoveCheckOut)
def check_move_endpoint(payload: MoveCheckIn, db: Session = Depends(get_db), user: User = Depends(view)) -> MoveCheckOut:
    """Перед переносом: не встанет ли этап раньше предыдущего или позже
    следующего, и что сдвинется, если сдвигать следующие этапы."""
    to = to_workday(payload.to_date)
    changes: list[tuple[int, int | None, date]] = []
    if payload.cell is not None:
        c = payload.cell
        line_ids = [ln.id for ln, t in _active_lines(db) if t.area == c.area]
        q = db.query(PlanSlot).filter(PlanSlot.task_line_id.in_(line_ids or [-1]))
        q = q.filter(PlanSlot.date <= c.from_date) if c.include_earlier else q.filter(PlanSlot.date == c.from_date)
        changes = [(sl.task_line_id, sl.id, to) for sl in q]
    elif payload.slot_id is not None:
        sl = _get_slot(db, payload.slot_id)
        changes = [(sl.task_line_id, None if payload.split else sl.id, to)]
    if not changes:
        return MoveCheckOut(conflicts=[], will_shift=[])
    areas = {a.code: a.name for a in db.query(Area)}
    stages = {st.id: st.name for st in db.query(PartStage)}
    conflicts = check_move(db, changes)
    # Что сдвинется: прогон в savepoint и откат.
    will: list[ShiftOut] = []
    if any(c.relation == "next" for c in conflicts):
        sp = db.begin_nested()
        moved_lines = set()
        for line_id, slot_id, d in changes:
            if slot_id is not None:
                db.get(PlanSlot, slot_id).date = d
            else:
                db.add(PlanSlot(task_line_id=line_id, date=d, quantity=0, auto=False, created_by=user.id))
            moved_lines.add(line_id)
        db.flush()
        before = {}
        all_slots = db.query(PlanSlot).all()
        for sl in all_slots:
            before.setdefault(sl.task_line_id, []).append(sl.date)
        before_min = {k: min(v) for k, v in before.items()}
        shift_following(db, moved_lines)
        after_min: dict[int, date] = {}
        for sl in db.query(PlanSlot).all():
            after_min[sl.task_line_id] = min(after_min.get(sl.task_line_id, sl.date), sl.date)
        for lid, d_before in before_min.items():
            d_after = after_min.get(lid)
            if d_after and d_after != d_before and lid not in moved_lines:
                ln = db.get(ProductionTaskLine, lid)
                will.append(
                    ShiftOut(
                        what=ln.part_name or "—", operation=stages.get(ln.part_stage_id), area_name=areas.get(ln.task.area, ln.task.area),
                        before=d_before, after=d_after,
                    )
                )
        sp.rollback()
    return MoveCheckOut(
        conflicts=[
            ConflictOut(what=c.what, operation=c.operation, area_name=areas.get(c.area, c.area), relation=c.relation, start=c.start, need=c.need)
            for c in conflicts
        ],
        will_shift=sorted(will, key=lambda x: x.after),
    )
