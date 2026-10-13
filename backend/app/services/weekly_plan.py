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

from app.models.customer_orders import CO_ACCEPTED, CO_SUBMITTED, CustomerOrder, CustomerOrderLine
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


def order_day(o) -> date | None:
    return o.promised_ready or o.ship_date


# С 13.10 в плане два вида строк: заказ на производство (запущенный или
# собранный черновик) и заказ клиента — его незапущенный остаток.
def is_co(o) -> bool:
    return isinstance(o, CustomerOrder)


def entry_key(o) -> str:
    return f"co:{o.id}" if is_co(o) else f"po:{o.id}"


def covered_keys(db: Session, o) -> set[str]:
    """Строка плана и заказы клиентов, собранные в неё: принятый заказ
    клиента после запуска недели — тот же пункт плана, не «убран»."""
    keys = {entry_key(o)}
    if not is_co(o):
        ids = {ln.customer_order_line_id for ln in o.lines if ln.customer_order_line_id}
        if ids:
            keys |= {f"co:{i}" for (i,) in db.query(CustomerOrderLine.order_id).filter(CustomerOrderLine.id.in_(ids)).distinct()}
    return keys


def entry_label(o) -> str:
    return f"заказ клиента {o.name}" if is_co(o) else f"№{o.id} «{o.name}»"


def is_request(o) -> bool:
    """Отправлен, ещё не принят производством — в план не входит."""
    return o.status == CO_SUBMITTED if is_co(o) else (o.status == ORDER_DRAFT and o.request_status == "submitted")


def entry_state(o) -> str:
    if is_co(o):
        return "заявка" if o.status == CO_SUBMITTED else "принят"
    if o.status != ORDER_DRAFT:
        return "запущен"
    if any(ln.customer_order_line_id for ln in o.lines):
        return "собран"
    return "принят" if o.request_status == "accepted" else "заявка"


def entry_qty(db: Session, o) -> float:
    if is_co(o):
        from app.services.customer_orders import remaining_lines

        return round(sum(left for _ln, left in remaining_lines(db, o)), 2)
    return sum(float(ln.quantity) for ln in o.lines)


def get_plan(db: Session, ws: date, create: bool = False) -> ProductionPlan | None:
    plan = db.query(ProductionPlan).filter(ProductionPlan.week_start == ws).first()
    if plan is None and create:
        plan = ProductionPlan(week_start=ws, status=PLAN_DRAFT, version=0)
        db.add(plan)
        db.flush()
    return plan


def week_orders(db: Session, ws: date) -> list:
    """Заказы недели (по обещанной готовности, иначе отгрузке): запущенные и
    собранные заказы на производство + заказы клиентов с незапущенным
    остатком (принятые и отправленные)."""
    from app.services.customer_orders import remaining_lines

    we = ws + timedelta(days=6)
    out: list = []
    for o in db.query(ProductionOrder).filter(ProductionOrder.status.in_([ORDER_DRAFT, ORDER_RELEASED]), ProductionOrder.kind != "stock"):
        d = order_day(o)
        if d is None or not (ws <= d <= we):
            continue
        if o.status == ORDER_DRAFT and entry_state(o) == "заявка" and o.request_status != "submitted":
            continue
        out.append(o)
    for co in db.query(CustomerOrder).filter(CustomerOrder.status.in_([CO_ACCEPTED, CO_SUBMITTED])):
        d = order_day(co) or (co.ship_to if co.status == CO_SUBMITTED else None)
        if d is None or not (ws <= d <= we):
            continue
        if remaining_lines(db, co):
            out.append(co)
    out.sort(key=lambda o: (-(o.priority or 0), order_day(o) or o.ship_to or ws, is_co(o), o.id))
    return out


@dataclass
class Load:
    days: list[date]
    areas: dict[str, dict[date, float]] = field(default_factory=dict)  # участок → день → штук
    capacity: dict[str, dict[date, float]] = field(default_factory=dict)  # участок → день → мощность (0 — нерабочий)
    by_order: dict[str, dict[str, float]] = field(default_factory=dict)  # entry_key → участок → штук на неделе


def week_load(db: Session, ws: date, orders: list, user_id: int) -> Load:
    from app.services.areas import area_capacities
    from app.services.customer_orders import transient_production_order
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

    order_of_task = {
        t.id: f"po:{t.production_order_id}"
        for t in db.query(ProductionTask).filter(ProductionTask.is_active.is_(True), ProductionTask.production_order_id.isnot(None))
    }
    collect(slots_in_week(), order_of_task)

    # принятые, ещё не запущенные — запуск в точке сохранения и откат
    drafts = [o for o in orders if entry_state(o) in ("принят", "собран")]
    if drafts:
        sp = db.begin_nested()
        try:
            new_tasks: set[int] = set()
            for o in drafts:
                try:
                    po = transient_production_order(db, o, user_id) if is_co(o) else o
                    if po is None:
                        continue
                    tasks = trial_release(db, po, user_id).tasks
                    for t in tasks:
                        new_tasks.add(t.id)
                        task_area[t.id] = t.area
                        order_of_task[t.id] = entry_key(o)
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


def snapshot(db: Session, plan: ProductionPlan, orders: list) -> None:
    for o in orders:
        db.add(ProductionPlanItem(
            plan_id=plan.id, version=plan.version, order_id=None if is_co(o) else o.id, customer_order_id=o.id if is_co(o) else None,
            order_name=o.name, priority=o.priority or 0, promised_ready=o.promised_ready, ship_date=o.ship_date, qty=entry_qty(db, o),
        ))


def item_key(i: ProductionPlanItem) -> str:
    return f"co:{i.customer_order_id}" if i.customer_order_id else f"po:{i.order_id}"


def event(db: Session, plan: ProductionPlan, kind: str, text: str, user_id: int | None, order_id: int | None = None) -> None:
    db.add(ProductionPlanEvent(plan_id=plan.id, kind=kind, text=text[:500], user_id=user_id, order_id=order_id))


def note_change(db: Session, order, old_day: date | None, new_day: date | None, text: str, user_id: int | None) -> None:
    """Заказ вошёл в неделю, ушёл из неё или поменял дату — у
    утверждённого/отправленного плана этой недели: «изменён» и запись."""
    weeks = {week_start(d) for d in (old_day, new_day) if d}
    for ws in weeks:
        plan = get_plan(db, ws)
        if plan is None or plan.status == PLAN_DRAFT:
            continue
        if plan.status == PLAN_APPROVED:
            plan.status = PLAN_CHANGED
        event(db, plan, "change", f"{entry_label(order)}: {text}", user_id, None if is_co(order) else order.id)


def submit(db: Session, plan: ProductionPlan, orders: list, user_id: int, comment: str | None) -> None:
    plan.status = PLAN_SUBMITTED
    plan.submitted_by, plan.submitted_at = user_id, datetime.now(timezone.utc)
    plan.comment = comment
    event(db, plan, "submit", f"Отправлен на утверждение: заказов {len(orders)}" + (f". {comment}" if comment else ""), user_id)


def approve(db: Session, plan: ProductionPlan, orders: list, user_id: int, comment: str | None) -> None:
    plan.version += 1
    plan.status = PLAN_APPROVED
    plan.approved_by, plan.approved_at = user_id, datetime.now(timezone.utc)
    snapshot(db, plan, orders)
    event(db, plan, "approve", f"Утверждён, версия {plan.version}: заказов {len(orders)}" + (f". {comment}" if comment else ""), user_id)


def return_plan(db: Session, plan: ProductionPlan, user_id: int, comment: str) -> None:
    plan.status = PLAN_DRAFT if plan.version == 0 else PLAN_CHANGED
    event(db, plan, "return", f"Возвращён: {comment}", user_id)


from app.services.trial_release import default_picks  # noqa: E402,F401 — «Запустить неделю» берёт отсюда
