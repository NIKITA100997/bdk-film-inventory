"""План недели (12.10, планирование, этап 3).

В план недели входят заказы с обещанной готовностью (или отгрузкой, если
готовность не задана) на эту неделю: запущенные и принятые заявки;
отправленные заявки — видны отдельно, ждут приёма. Загрузка участков по
дням: дни плана запущенных заказов плюс принятые, запущенные в точке
сохранения с откатом; мощность — по линиям/участку и календарю.

Утверждение: черновик → на утверждении → утверждён (версия +1, снимок
состава). Изменение после утверждения (срочный заказ, перенос, новая
принятая заявка) — «изменён», запись в журнал; начатые заказы не
двигаются — сроки пересчитываются только у изменённого заказа."""

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models.plans import (
    PLAN_APPROVED,
    PLAN_CHANGED,
    PLAN_DRAFT,
    PLAN_SUBMITTED,
    ProductionPlan,
    ProductionPlanEvent,
    ProductionPlanItem,
)
from app.models.production import PlanSlot, ProductionTask
from app.models.production_orders import ORDER_DRAFT, ORDER_RELEASED, ProductionOrder


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def order_day(o: ProductionOrder) -> date | None:
    return o.promised_ready or o.ship_date


def get_plan(db: Session, ws: date, create: bool = False) -> ProductionPlan | None:
    plan = db.query(ProductionPlan).filter(ProductionPlan.week_start == ws).first()
    if plan is None and create:
        plan = ProductionPlan(week_start=ws, status=PLAN_DRAFT, version=0)
        db.add(plan)
        db.flush()
    return plan


def week_orders(db: Session, ws: date) -> list[ProductionOrder]:
    we = ws + timedelta(days=6)
    out = []
    for o in db.query(ProductionOrder).filter(ProductionOrder.status.in_([ORDER_DRAFT, ORDER_RELEASED]), ProductionOrder.kind != "stock"):
        d = order_day(o)
        if d is None or not (ws <= d <= we):
            continue
        if o.status == ORDER_DRAFT and o.request_status not in ("accepted", "submitted"):
            continue
        out.append(o)
    out.sort(key=lambda o: (-(o.priority or 0), order_day(o) or ws, o.id))
    return out


@dataclass
class Load:
    days: list[date]
    areas: dict[str, dict[date, float]] = field(default_factory=dict)  # участок → день → штук
    capacity: dict[str, dict[date, float]] = field(default_factory=dict)  # участок → день → мощность (0 — нерабочий)
    by_order: dict[int, dict[str, float]] = field(default_factory=dict)  # заказ → участок → штук на неделе


def week_load(db: Session, ws: date, orders: list[ProductionOrder], user_id: int) -> Load:
    from app.services.areas import area_capacities
    from app.services.planning import is_workday, load_calendar
    from app.services.production_orders import OrderError
    from app.services.trial_release import trial_release

    load_calendar(db)
    days = [ws + timedelta(days=i) for i in range(7)]
    res = Load(days=days)
    task_area = {t.id: t.area for t in db.query(ProductionTask.id, ProductionTask.area)}

    def collect(slots, order_of_task):
        for s, task_id in slots:
            if s.date < days[0] or s.date > days[-1]:
                continue
            area = task_area.get(task_id)
            if area is None:
                continue
            res.areas.setdefault(area, {}).setdefault(s.date, 0.0)
            res.areas[area][s.date] += float(s.quantity)
            oid = order_of_task.get(task_id)
            if oid:
                res.by_order.setdefault(oid, {}).setdefault(area, 0.0)
                res.by_order[oid][area] += float(s.quantity)

    from app.models.production import ProductionTaskLine

    def slots_in_week():
        return (
            db.query(PlanSlot, ProductionTaskLine.task_id)
            .join(ProductionTaskLine, ProductionTaskLine.id == PlanSlot.task_line_id)
            .filter(PlanSlot.date >= days[0], PlanSlot.date <= days[-1])
            .all()
        )

    order_of_task = {t.id: t.production_order_id for t in db.query(ProductionTask).filter(ProductionTask.is_active.is_(True))}
    collect(slots_in_week(), order_of_task)

    # принятые, ещё не запущенные — запуск в точке сохранения и откат
    drafts = [o for o in orders if o.status == ORDER_DRAFT and o.request_status == "accepted"]
    if drafts:
        sp = db.begin_nested()
        try:
            new_tasks: set[int] = set()
            for o in drafts:
                try:
                    tasks = trial_release(db, o, user_id).tasks
                    for t in tasks:
                        new_tasks.add(t.id)
                        task_area[t.id] = t.area
                        order_of_task[t.id] = o.id
                except OrderError:
                    continue
            collect([(s, tid) for s, tid in slots_in_week() if tid in new_tasks], order_of_task)
        finally:
            sp.rollback()

    caps = area_capacities(db)
    for area in res.areas:
        per = caps.get(area)
        res.capacity[area] = {d: (per if is_workday(d, area) else 0.0) if per else (None if is_workday(d, area) else 0.0) for d in days}
    return res


def snapshot(db: Session, plan: ProductionPlan, orders: list[ProductionOrder]) -> None:
    for o in orders:
        db.add(ProductionPlanItem(
            plan_id=plan.id, version=plan.version, order_id=o.id, order_name=o.name, priority=o.priority or 0,
            promised_ready=o.promised_ready, ship_date=o.ship_date, qty=sum(float(ln.quantity) for ln in o.lines),
        ))


def event(db: Session, plan: ProductionPlan, kind: str, text: str, user_id: int | None, order_id: int | None = None) -> None:
    db.add(ProductionPlanEvent(plan_id=plan.id, kind=kind, text=text[:500], user_id=user_id, order_id=order_id))


def note_change(db: Session, order: ProductionOrder, old_day: date | None, new_day: date | None, text: str, user_id: int | None) -> None:
    """Заказ вошёл в неделю, ушёл из неё или поменял дату — у
    утверждённого/отправленного плана этой недели: «изменён» и запись."""
    weeks = {week_start(d) for d in (old_day, new_day) if d}
    for ws in weeks:
        plan = get_plan(db, ws)
        if plan is None or plan.status == PLAN_DRAFT:
            continue
        if plan.status == PLAN_APPROVED:
            plan.status = PLAN_CHANGED
        event(db, plan, "change", f"№{order.id} «{order.name}»: {text}", user_id, order.id)


def submit(db: Session, plan: ProductionPlan, orders: list[ProductionOrder], user_id: int, comment: str | None) -> None:
    plan.status = PLAN_SUBMITTED
    plan.submitted_by, plan.submitted_at = user_id, datetime.now(timezone.utc)
    plan.comment = comment
    event(db, plan, "submit", f"Отправлен на утверждение: заказов {len(orders)}" + (f". {comment}" if comment else ""), user_id)


def approve(db: Session, plan: ProductionPlan, orders: list[ProductionOrder], user_id: int, comment: str | None) -> None:
    plan.version += 1
    plan.status = PLAN_APPROVED
    plan.approved_by, plan.approved_at = user_id, datetime.now(timezone.utc)
    snapshot(db, plan, orders)
    event(db, plan, "approve", f"Утверждён, версия {plan.version}: заказов {len(orders)}" + (f". {comment}" if comment else ""), user_id)


def return_plan(db: Session, plan: ProductionPlan, user_id: int, comment: str) -> None:
    plan.status = PLAN_DRAFT if plan.version == 0 else PLAN_CHANGED
    event(db, plan, "return", f"Возвращён: {comment}", user_id)


from app.services.trial_release import default_picks  # noqa: E402,F401 — «Запустить неделю» берёт отсюда
