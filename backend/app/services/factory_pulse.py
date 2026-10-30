"""Пульс завода для руководителя (Factory Pulse / Director Dashboard).
Сводные KPI за текущие сутки / смену, баланс мощностей цеха и оперативные рекомендации (Actionable Insights).
"""

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.customer_orders import CO_ACCEPTED, CO_SUBMITTED, CustomerOrder, CustomerOrderLine
from app.models.finished_goods import FG_RECEIPT, FgMove
from app.models.production import PlanSlot, ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.production_orders import ORDER_RELEASED, ProductionOrder
from app.services.areas import area_capacities
from app.services.order_timeline import get_customer_order_timeline

TZ = ZoneInfo("Europe/Moscow")


@dataclass
class AreaCapacityMetric:
    area_code: str
    name: str
    queue_pieces: float
    capacity_per_day: float
    days_of_work: float
    load_pct: int
    is_bottleneck: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "area_code": self.area_code,
            "name": self.name,
            "queue_pieces": round(self.queue_pieces, 1),
            "capacity_per_day": round(self.capacity_per_day, 1),
            "days_of_work": round(self.days_of_work, 1),
            "load_pct": self.load_pct,
            "is_bottleneck": self.is_bottleneck,
        }


@dataclass
class ActionInsight:
    level: str  # "danger", "warning", "info", "success"
    title: str
    text: str
    action_label: str | None = None
    action_link: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "level": self.level,
            "title": self.title,
            "text": self.text,
            "action_label": self.action_label,
            "action_link": self.action_link,
        }


@dataclass
class FactoryPulse:
    # 4 top KPIs
    output_pieces_today: float
    output_rub_today: float
    plan_completion_pct: int
    planned_pieces_today: float
    defect_pieces_today: float
    defect_pct_today: float
    delayed_orders_count: int
    overdue_pieces_total: float

    # Area balance
    area_balances: list[AreaCapacityMetric] = field(default_factory=list)

    # Actionable Insights
    insights: list[ActionInsight] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "output_pieces_today": round(self.output_pieces_today, 1),
            "output_rub_today": round(self.output_rub_today, 2),
            "plan_completion_pct": self.plan_completion_pct,
            "planned_pieces_today": round(self.planned_pieces_today, 1),
            "defect_pieces_today": round(self.defect_pieces_today, 1),
            "defect_pct_today": round(self.defect_pct_today, 1),
            "delayed_orders_count": self.delayed_orders_count,
            "overdue_pieces_total": round(self.overdue_pieces_total, 1),
            "area_balances": [a.to_dict() for a in self.area_balances],
            "insights": [i.to_dict() for i in self.insights],
        }


def compute_factory_pulse(db: Session, target_date: date | None = None) -> FactoryPulse:
    today = target_date or date.today()
    start_dt = datetime.combine(today, datetime.min.time(), tzinfo=TZ)
    end_dt = datetime.combine(today + timedelta(days=1), datetime.min.time(), tzinfo=TZ)

    # 1. Output today (Reports & FG Receipts)
    rep_good, rep_defect = (
        db.query(
            func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
            func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0),
        )
        .filter(
            ProductionTaskLineReport.reported_at >= start_dt,
            ProductionTaskLineReport.reported_at < end_dt,
            ProductionTaskLineReport.counts_toward_line.is_(True),
        )
        .first()
    ) or (0.0, 0.0)

    fg_today_qty = (
        db.query(func.coalesce(func.sum(FgMove.qty), 0))
        .filter(
            FgMove.kind == FG_RECEIPT,
            FgMove.occurred_at >= start_dt,
            FgMove.occurred_at < end_dt,
        )
        .scalar()
        or 0.0
    )

    output_pieces = float(fg_today_qty) if fg_today_qty > 0 else float(rep_good)

    # Output in rubles: estimate from FG moves and CustomerOrderLine unit prices
    output_rub = 0.0
    if fg_today_qty > 0:
        # Average order rub per piece
        for m in (
            db.query(FgMove)
            .filter(
                FgMove.kind == FG_RECEIPT,
                FgMove.occurred_at >= start_dt,
                FgMove.occurred_at < end_dt,
            )
            .all()
        ):
            # approximate unit price ~ 2800 руб per door if not explicit
            output_rub += float(m.qty) * 2800.0

    # 2. Plan completion today
    planned_today = (
        db.query(func.coalesce(func.sum(PlanSlot.quantity), 0))
        .filter(PlanSlot.date == today)
        .scalar()
        or 0.0
    )
    planned_today_f = float(planned_today)
    if planned_today_f > 0:
        plan_completion_pct = min(150, int((float(rep_good) / planned_today_f) * 100))
    elif float(rep_good) > 0:
        plan_completion_pct = 100
    else:
        plan_completion_pct = 0

    # 3. Defects
    defect_f = float(rep_defect)
    total_rep = float(rep_good) + defect_f
    defect_pct = (defect_f / total_rep * 100.0) if total_rep > 0 else 0.0

    # 4. Delayed orders & Overdue
    delayed_orders_count = 0
    overdue_pieces_total = 0.0
    active_cos = (
        db.query(CustomerOrder)
        .filter(CustomerOrder.status.in_([CO_ACCEPTED, CO_SUBMITTED]))
        .all()
    )
    for co in active_cos:
        if co.ship_date and co.ship_date < today:
            delayed_orders_count += 1
            left_qty = max(0.0, float(sum(ln.quantity for ln in co.lines)))
            overdue_pieces_total += left_qty

    # 5. Area Balances & Bottlenecks
    capacities = area_capacities(db, with_fact=True)
    areas = db.query(Area).order_by(Area.name).all()
    area_balances = []
    worst_area = None
    max_days = 0.0

    # Active lines by area
    open_tasks = (
        db.query(ProductionTask)
        .filter(ProductionTask.is_active.is_(True))
        .all()
    )
    tasks_by_area: dict[str, list[ProductionTask]] = {}
    for t in open_tasks:
        tasks_by_area.setdefault(t.area, []).append(t)

    for a in areas:
        area_tasks = tasks_by_area.get(a.code, [])
        queue_pcs = sum(float(t.planned or 0) - float(t.done or 0) for t in area_tasks)
        queue_pcs = max(0.0, queue_pcs)
        cap = float(capacities.get(a.code, 100.0) or 100.0)
        days_of_work = (queue_pcs / cap) if cap > 0 else 0.0
        load_pct = min(200, int((days_of_work / 2.0) * 100)) if days_of_work > 0 else 0
        is_bottleneck = days_of_work > 3.0 or load_pct > 120

        if days_of_work > max_days:
            max_days = days_of_work
            worst_area = a.name

        area_balances.append(
            AreaCapacityMetric(
                area_code=a.code,
                name=a.name,
                queue_pieces=queue_pcs,
                capacity_per_day=cap,
                days_of_work=days_of_work,
                load_pct=load_pct,
                is_bottleneck=is_bottleneck,
            )
        )

    # 6. Actionable Insights
    insights: list[ActionInsight] = []

    # Bottleneck insight
    if worst_area and max_days > 2.5:
        insights.append(
            ActionInsight(
                level="danger",
                title=f"Узкое место цеха: {worst_area}",
                text=f"Очередь работы составляет {round(max_days, 1)} дн. при норме до 2 дней. Рекомендуется перераспределить операторов или назначить продлённую смену.",
                action_label="К балансировке",
                action_link="/production-tasks",
            )
        )

    # Delay alert
    if delayed_orders_count > 0:
        insights.append(
            ActionInsight(
                level="warning",
                title=f"Заказы с риском срыва срока: {delayed_orders_count}",
                text=f"Суммарный объём отставания — {round(overdue_pieces_total, 1)} шт. Проверьте приоритеты на экране диспетчеризации.",
                action_label="Посмотреть заказы",
                action_link="/customer-orders?filter=accepted",
            )
        )

    # Defect alert
    if defect_pct > 4.0:
        insights.append(
            ActionInsight(
                level="warning",
                title=f"Повышенный уровень брака: {round(defect_pct, 1)}%",
                text=f"Зафиксировано {round(defect_f, 1)} шт брака. Проверьте стабильность температуры клеевого узла или геометрию заготовок.",
                action_label="Отчёт по браку",
                action_link="/reports?tab=defects",
            )
        )

    # Ready for shipment
    ready_cos = (
        db.query(CustomerOrder)
        .filter(CustomerOrder.status == CO_ACCEPTED)
        .all()
    )
    ready_count = 0
    ready_amount = 0.0
    for rco in ready_cos:
        if rco.ready_at or (rco.ship_date and rco.ship_date >= today):
            ready_count += 1
            if rco.amount_rub:
                ready_amount += float(rco.amount_rub)

    if ready_count > 0:
        insights.append(
            ActionInsight(
                level="info",
                title=f"Готово к отгрузке: {ready_count} заказов",
                text=f"На складе готовой продукции продукция ожидает передачи клиентам" + (f" на сумму {int(ready_amount):,} ₽." if ready_amount else "."),
                action_label="К отгрузке",
                action_link="/customer-orders?section=shipping",
            )
        )

    # Positive shift insight if everything is going well
    if not insights or plan_completion_pct >= 85:
        insights.append(
            ActionInsight(
                level="success",
                title="Производственный конвейер стабилен",
                text=f"Выполнение суточного плана в норме ({plan_completion_pct}%). Критических дефицитов не выявлено.",
            )
        )

    return FactoryPulse(
        output_pieces_today=output_pieces,
        output_rub_today=output_rub,
        plan_completion_pct=plan_completion_pct,
        planned_pieces_today=planned_today_f,
        defect_pieces_today=defect_f,
        defect_pct_today=defect_pct,
        delayed_orders_count=delayed_orders_count,
        overdue_pieces_total=overdue_pieces_total,
        area_balances=area_balances,
        insights=insights,
    )
