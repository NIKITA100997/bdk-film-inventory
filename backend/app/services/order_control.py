"""Контроль заказов (12.10, планирование, этап 4).

- Отставания: у запущенного заказа работы прошедших дней плана не сделаны
  («просрочено, шт») или план кончается позже обещанной готовности.
- Уменьшение строки запущенного заказа: по каждой строке заданий —
  сколько уже сделано; уменьшается только несделанное, сделанное сверх
  нового количества остаётся: п/ф — в общем остатке участка под другие
  двери (расход п/ф по участку, FIFO), двери — на складе ГП.
- Отчёт по срокам: вовремя ли готово и отгружено, по менеджерам; причины
  переносов."""

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.production_orders import ORDER_CLOSED, ORDER_RELEASED, OrderDateChange, ProductionOrder, ProductionOrderLine
from app.models.users import User
from app.services.planning import order_plan_status


# ─── отставания ──────────────────────────────────────────────────────────


@dataclass
class Lag:
    order_id: int
    name: str
    customer: str | None
    manager_id: int | None
    overdue: float  # штук в прошедших днях плана, не сделано
    plan_finish: date | None
    promised_ready: date | None
    late: bool


def lagging(db: Session) -> list[Lag]:
    out = []
    for o in db.query(ProductionOrder).filter(ProductionOrder.status == ORDER_RELEASED, ProductionOrder.kind != "stock"):
        ps = order_plan_status(db, o)
        if ps.overdue > 0 or ps.late:
            out.append(Lag(order_id=o.id, name=o.name, customer=o.customer, manager_id=o.submitted_by or o.created_by,
                           overdue=ps.overdue, plan_finish=ps.finish, promised_ready=o.promised_ready or o.ship_date, late=ps.late))
    out.sort(key=lambda x: (not x.late, -x.overdue))
    return out


def lag_digest(db: Session, today: date | None = None) -> int:
    """Утренняя сводка отставаний в Битрикс24 — раз в рабочий день:
    в чат производства и каждому менеджеру по его заказам."""
    from app.models.integrations import AppSetting
    from app.services import bitrix
    from app.services.planning import is_workday, load_calendar

    today = today or date.today()
    load_calendar(db)
    if not is_workday(today):
        return 0
    s = bitrix.get_settings(db)
    if not s.get("enabled") or not s.get("webhook"):
        return 0
    mark = db.get(AppSetting, "lag_digest")
    if mark is not None and mark.value == today.isoformat():
        return 0
    lags = lagging(db)
    if mark is None:
        mark = AppSetting(key="lag_digest")
        db.add(mark)
    mark.value = today.isoformat()
    if not lags:
        db.commit()
        return 0

    def line(x: Lag) -> str:
        what = []
        if x.overdue:
            what.append(f"не сделано по плану прошедших дней {x.overdue:g} шт")
        if x.late:
            what.append(f"готово по плану {x.plan_finish:%d.%m} позже обещанного {x.promised_ready:%d.%m}" if x.plan_finish and x.promised_ready else "не успевает")
        o = db.get(ProductionOrder, x.order_id)
        return f"• {bitrix.order_title(db, o)}: " + "; ".join(what)

    bitrix.message_to_chat(db, "lag_digest", "chat_production", f"Отстают от плана ({today:%d.%m}): {len(lags)}\n" + "\n".join(line(x) for x in lags[:30]))
    by_manager: dict[int, list[Lag]] = defaultdict(list)
    for x in lags:
        if x.manager_id:
            by_manager[x.manager_id].append(x)
    for uid, xs in by_manager.items():
        bitrix.message_to_user(db, "lag_digest", uid, "Ваши заказы отстают от плана:\n" + "\n".join(line(x) for x in xs))
    db.commit()
    return len(lags)


# ─── уменьшение строки заказа ────────────────────────────────────────────


@dataclass
class ReduceRow:
    task_line_id: int
    area: str
    what: str
    old: float
    new: float
    done: float
    surplus: float  # сделано сверх нового количества


@dataclass
class ReducePlan:
    rows: list[ReduceRow] = field(default_factory=list)
    merged: list[str] = field(default_factory=list)  # объединённые строки п/ф — не уменьшаются


def reduce_line(db: Session, order: ProductionOrder, ol: ProductionOrderLine, new_qty: float, apply: bool) -> ReducePlan:
    old_qty = float(ol.quantity)
    tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id).all()
    lines = [(ln, t) for t in tasks for ln in t.lines]
    done = dict(
        db.query(ProductionTaskLineReport.task_line_id, func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
        .filter(ProductionTaskLineReport.task_line_id.in_([ln.id for ln, _ in lines] or [-1]))
        .group_by(ProductionTaskLineReport.task_line_id)
    )
    from app.models.areas import Area

    area_names = {a.code: a.name for a in db.query(Area)}
    plan = ReducePlan()
    for ln, t in lines:
        if ln.order_line_id != ol.id:
            if ln.order_line_id is None and ln.part_id is not None:
                plan.merged.append(f"{ln.part_name} ({area_names.get(t.area, t.area)})")
            continue
        q = float(ln.quantity_pieces)
        target = round(q * new_qty / old_qty, 2) if old_qty else new_qty
        d = float(done.get(ln.id, 0))
        new = max(d, target)
        plan.rows.append(ReduceRow(task_line_id=ln.id, area=area_names.get(t.area, t.area), what=ln.part_name or "", old=q, new=new, done=d,
                                   surplus=round(max(0.0, d - target), 2)))
        if apply:
            ln.quantity_pieces = new
    if apply:
        ol.quantity = new_qty
        db.flush()
    plan.merged = sorted(set(plan.merged))
    return plan


# ─── отчёт по срокам ─────────────────────────────────────────────────────


@dataclass
class DeadlineRow:
    order_id: int
    name: str
    customer: str | None
    manager: str | None
    status: str
    promised_ready: date | None
    ready_fact: date | None
    ready_on_time: bool | None
    ship_date: date | None
    shipped_at: date | None
    shipped_all: bool
    ship_on_time: bool | None
    moves: int


def deadlines(db: Session, date_from: date, date_to: date) -> tuple[list[DeadlineRow], dict, list[tuple[str, int]]]:
    from app.api.production_orders import DATE_CHANGE_REASONS, _fact_fields  # noqa: PLC2701

    rows: list[DeadlineRow] = []
    names = {u.id: (u.full_name or u.username) for u in db.query(User)}
    q = db.query(ProductionOrder).filter(
        ProductionOrder.status.in_([ORDER_RELEASED, ORDER_CLOSED]), ProductionOrder.kind != "stock",
        ProductionOrder.ship_date >= date_from, ProductionOrder.ship_date <= date_to,
    )
    for o in q.order_by(ProductionOrder.ship_date):
        f = _fact_fields(db, o)
        qty = sum(float(ln.quantity) for ln in o.lines)
        shipped_all = qty > 0 and f["shipped_qty"] >= qty - 0.001
        rf, sa = f["ready_fact"], f["last_shipped_at"]
        rows.append(DeadlineRow(
            order_id=o.id, name=o.name, customer=o.customer, manager=names.get(o.submitted_by or o.created_by), status=o.status,
            promised_ready=o.promised_ready, ready_fact=rf,
            ready_on_time=(rf <= o.promised_ready) if (rf and o.promised_ready) else None,
            ship_date=o.ship_date, shipped_at=sa, shipped_all=shipped_all,
            ship_on_time=(sa <= o.ship_date) if (shipped_all and sa) else (False if date.today() > o.ship_date and not shipped_all else None),
            moves=len([c for c in f["date_changes"] if c.reason]),
        ))
    by_manager: dict[str, dict] = defaultdict(lambda: {"orders": 0, "on_time": 0, "late": 0})
    for r in rows:
        m = by_manager[r.manager or "—"]
        m["orders"] += 1
        if r.ship_on_time is True:
            m["on_time"] += 1
        elif r.ship_on_time is False:
            m["late"] += 1
    reasons = Counter(
        c.reason for c in db.query(OrderDateChange).filter(
            OrderDateChange.reason.isnot(None),
            OrderDateChange.created_at >= datetime.combine(date_from, datetime.min.time()),
            OrderDateChange.created_at <= datetime.combine(date_to, datetime.max.time()),
        )
    )
    return rows, dict(by_manager), [(DATE_CHANGE_REASONS.get(k, k), v) for k, v in reasons.most_common()]
