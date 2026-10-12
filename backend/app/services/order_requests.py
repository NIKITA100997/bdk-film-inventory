"""Заявки менеджеров на производство (09.10): оценка срока до запуска.

Менеджер (продажник) заводит заказ-черновик с вилкой отгрузки и до отправки
видит, успевает ли производство. Оценка — запуск заказа по-настоящему с
откатом (как раскладка перед запуском) и два ограничения:

- маршрут: сроки операций назад от сегодня (lead_days участков), как
  планировщик ставит сроки заказу без даты отгрузки;
- загрузка: на участках с мощностью (сумма линий или участка) сначала
  очередь — невыполненный остаток открытых заданий, потом сам заказ.

Ранняя готовность — позднее из двух. Это оценка, не план: порядок очереди
решает начальник цеха."""

import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.production import ProductionTask
from app.models.production_orders import ProductionOrder
from app.services.areas import area_capacities
from app.services.planning import (
    PfPick,
    _good_by_line,  # noqa: PLC2701
    add_workdays,
    order_pf_needs,
    release_pf,
    schedule_order,
    to_workday,
)
from app.services.production_orders import OrderError, release_order

REQ_SUBMITTED = "submitted"
REQ_RETURNED = "returned"
REQ_ACCEPTED = "accepted"


@dataclass
class AreaLoad:
    area: str
    name: str
    order_pieces: float  # штук этого заказа на участке
    queue_pieces: float  # уже в очереди: остаток открытых заданий
    per_day: float | None  # мощность в день; None — не задана
    days: int | None  # очередь + заказ, рабочих дней


@dataclass
class PlanCheck:
    earliest: date | None  # раньше не получится
    by_route: date | None  # только по срокам операций
    bottleneck: str | None  # участок, который держит
    fits: bool | None  # успевает к концу вилки; None — вилки нет
    areas: list[AreaLoad] = field(default_factory=list)
    error: str | None = None


def _queue(db: Session, exclude_order: int) -> dict[str, float]:
    """Невыполненный остаток открытых заданий по участкам (кроме этого заказа)."""
    pairs = [
        (ln, t)
        for t in db.query(ProductionTask).filter(ProductionTask.is_active.is_(True))
        if t.production_order_id != exclude_order
        for ln in t.lines
        if not (ln.is_closed or ln.production_closed)
    ]
    good = _good_by_line(db, [ln.id for ln, _ in pairs])
    out: dict[str, float] = defaultdict(float)
    for ln, t in pairs:
        out[t.area] += max(0.0, float(ln.quantity_pieces) - good.get(ln.id, 0.0))
    return out


def plan_check(db: Session, order: ProductionOrder, user_id: int, today: date | None = None) -> PlanCheck:
    """Оценка ранней готовности заказа-черновика. Ничего не сохраняет —
    вызывающий обязан откатить сессию."""
    from app.services.planning import load_calendar

    load_calendar(db)
    today = to_workday(today or date.today())
    queue = _queue(db, order.id)
    caps = area_capacities(db)
    names = {a.code: a.name for a in db.query(Area)}
    try:
        tasks = release_order(db, order, user_id)
    except OrderError as e:
        return PlanCheck(earliest=None, by_route=None, bottleneck=None, fits=None, error=str(e))
    picks = [
        PfPick(order_line_id=n.order_line_id, part_id=n.part_id, quantity=n.launch,
               consumer_part_id=n.consumer_part_id, from_stock=n.from_stock)
        for n in order_pf_needs(db, order)
    ]
    tasks += release_pf(db, order, tasks, picks, user_id)
    ship = order.ship_date
    order.ship_date = None  # от сегодня, а не назад от отгрузки
    sched = schedule_order(db, order, user_id, today=today)
    order.ship_date = ship

    own: dict[str, float] = defaultdict(float)
    for t in db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id):
        for ln in t.lines:
            own[t.area] += float(ln.quantity_pieces)
    loads: list[AreaLoad] = []
    worst, bottleneck = 0, None
    for area, pieces in own.items():
        per_day = caps.get(area)
        days = math.ceil((queue.get(area, 0.0) + pieces) / per_day) if per_day else None
        loads.append(AreaLoad(area=area, name=names.get(area, area), order_pieces=round(pieces, 2),
                              queue_pieces=round(queue.get(area, 0.0), 2), per_day=per_day, days=days))
        if days is not None and days > worst:
            worst, bottleneck = days, area
    by_route = sched.finish
    by_load = add_workdays(today, worst) if worst else None
    earliest = max(d for d in (by_route, by_load) if d) if (by_route or by_load) else None
    # держит загрузка участка, если по ней выходит не раньше, чем по маршруту
    held = names.get(bottleneck, bottleneck) if by_load and (not by_route or by_load >= by_route) else None
    fits = None if order.ship_to is None or earliest is None else earliest <= order.ship_to
    loads.sort(key=lambda a: -(a.days or 0))
    return PlanCheck(earliest=earliest, by_route=by_route, bottleneck=held,
                     fits=fits, areas=loads)
