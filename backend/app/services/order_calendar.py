"""Календарь заказов для продаж и производства (14.10): по каждому заказу и
участку — план по дням (слоты планировщика), факт по концу дня (годные из
отчётов: день распределения, если отчёт за него, иначе день ввода отчёта)
и итог «сделано из нужного».

Строка календаря — заказ клиента (счёт 1С) или заказ на производство без
заказов клиентов (окутка, погонаж по счёту — так сейчас ведётся большая
часть работы). Строки заданий запуска относятся к заказу клиента через
строку заказа; объединённые строки п/ф (одна строка на несколько дверей —
каркасы, панели) делятся между заказами клиентов запуска пропорционально
их количеству в запуске."""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.customer_orders import CustomerOrderLine
from app.models.production import PlanSlot, ProductionTask, ProductionTaskLineAssignment, ProductionTaskLineReport
from app.models.production_orders import ORDER_CLOSED, ORDER_KIND_STOCK, ORDER_RELEASED, ProductionOrder

TZ = ZoneInfo("Europe/Moscow")


@dataclass
class AreaDays:
    area: str
    area_name: str
    need: float = 0.0  # всего по заказу на участке
    done: float = 0.0  # сделано всего (годные)
    days: dict[str, list[float]] = field(default_factory=dict)  # "YYYY-MM-DD" → [план, факт]


@dataclass
class CalendarRow:
    key: str  # "co:12" / "po:34"
    kind: str  # "co" | "po"
    id: int
    title: str
    customer: str | None
    status: str
    ship_date: date | None
    promised_ready: date | None
    plan_finish: date | None
    released: bool
    areas: list[AreaDays] = field(default_factory=list)


def calendar(db: Session, date_from: date, date_to: date) -> list[CalendarRow]:
    orders = (
        db.query(ProductionOrder)
        .filter(ProductionOrder.status.in_([ORDER_RELEASED, ORDER_CLOSED]), ProductionOrder.kind != ORDER_KIND_STOCK)
        .all()
    )
    if not orders:
        return []
    by_id = {o.id: o for o in orders}
    tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id.in_(list(by_id))).all()
    area_names = {a.code: a.name for a in db.query(Area)}
    co_of_line = dict(db.query(CustomerOrderLine.id, CustomerOrderLine.order_id))

    # строка заказа на производство → заказ клиента; доли заказов клиентов в запуске
    pol_co: dict[int, int] = {}
    shares: dict[int, list[tuple[int, float]]] = {}
    for o in orders:
        qty: dict[int, float] = defaultdict(float)
        for ol in o.lines:
            if ol.customer_order_line_id and ol.customer_order_line_id in co_of_line:
                co = co_of_line[ol.customer_order_line_id]
                pol_co[ol.id] = co
                qty[co] += float(ol.quantity)
        total = sum(qty.values())
        if total > 0:
            shares[o.id] = [(co, q / total) for co, q in qty.items()]

    # строка задания → [(ключ строки календаря, доля)], участок
    owner: dict[int, list[tuple[str, float]]] = {}
    area_of: dict[int, str] = {}
    need: dict[tuple[str, str], float] = defaultdict(float)
    for t in tasks:
        oid = t.production_order_id
        for ln in t.lines:
            if ln.order_line_id in pol_co:
                own = [(f"co:{pol_co[ln.order_line_id]}", 1.0)]
            elif oid in shares:
                own = [(f"co:{co}", s) for co, s in shares[oid]]
            else:
                own = [(f"po:{oid}", 1.0)]
            owner[ln.id] = own
            area_of[ln.id] = t.area
            for k, s in own:
                need[(k, t.area)] += float(ln.quantity_pieces) * s
    if not owner:
        return []
    line_ids = list(owner)

    cells: dict[tuple[str, str], dict[str, list[float]]] = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
    finish: dict[str, date] = {}
    for sl in db.query(PlanSlot).filter(PlanSlot.task_line_id.in_(line_ids)):
        for k, s in owner[sl.task_line_id]:
            finish[k] = max(finish.get(k, sl.date), sl.date)
            if date_from <= sl.date <= date_to:
                cells[(k, area_of[sl.task_line_id])][sl.date.isoformat()][0] += float(sl.quantity) * s

    done: dict[tuple[str, str], float] = defaultdict(float)
    for lid, g in (
        db.query(ProductionTaskLineReport.task_line_id, func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
        .filter(ProductionTaskLineReport.task_line_id.in_(line_ids), ProductionTaskLineReport.counts_toward_line.is_(True))
        .group_by(ProductionTaskLineReport.task_line_id)
    ):
        for k, s in owner[lid]:
            done[(k, area_of[lid])] += float(g) * s
    # отчёт за день распределения может быть введён позже — с запасом в неделю
    start = datetime.combine(date_from - timedelta(days=7), time.min, TZ)
    end = datetime.combine(date_to + timedelta(days=8), time.min, TZ)
    for r, work_day in (
        db.query(ProductionTaskLineReport, ProductionTaskLineAssignment.date)
        .outerjoin(ProductionTaskLineAssignment, ProductionTaskLineAssignment.id == ProductionTaskLineReport.assignment_id)
        .filter(
            ProductionTaskLineReport.task_line_id.in_(line_ids),
            ProductionTaskLineReport.counts_toward_line.is_(True),
            ProductionTaskLineReport.reported_at >= start,
            ProductionTaskLineReport.reported_at < end,
        )
    ):
        d = work_day or r.reported_at.astimezone(TZ).date()
        if not date_from <= d <= date_to:
            continue
        day = d.isoformat()
        for k, s in owner[r.task_line_id]:
            cells[(k, area_of[r.task_line_id])][day][1] += float(r.good_pieces) * s

    rows: dict[str, CalendarRow] = {}
    for (k, area), nd in need.items():
        if k not in rows:
            kind, sid = k.split(":")
            rows[k] = CalendarRow(key=k, kind=kind, id=int(sid), title="", customer=None, status="", ship_date=None,
                                  promised_ready=None, plan_finish=finish.get(k), released=False)
        days = {d: [round(p, 2), round(f, 2)] for d, (p, f) in sorted(cells[(k, area)].items())}
        rows[k].areas.append(AreaDays(area=area, area_name=area_names.get(area, area), need=round(nd, 2),
                                      done=round(done[(k, area)], 2), days=days))
    for r in rows.values():
        r.areas.sort(key=lambda a: a.area_name)
        if r.kind == "po":
            o = by_id[r.id]
            r.title, r.customer, r.status = o.name, o.customer, o.status
            r.ship_date, r.promised_ready = o.ship_date, getattr(o, "promised_ready", None)
            r.released = o.status == ORDER_RELEASED
    return list(rows.values())
