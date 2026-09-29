"""Планирование производства (29.09): п/ф под заказ и сроки операций.

  • п/ф под заказ — щитовым панели и каркасы делаются под заказ: при
    запуске двери разворачиваются по составу вглубь (дверь → каркас,
    панели → панель с узором → ламинированная панель) и запускаются
    заданиями на п/ф вместе с заказом, связанные с ним;
  • сроки — назад от даты отгрузки по рабочим дням (пн–пт): последняя
    операция двери — за день до отгрузки, каждая предыдущая — раньше на
    срок её участка (Area.lead_days, по умолчанию 1 день); п/ф — к дню
    операции, на которой расходуются. Без даты отгрузки — вперёд от
    сегодня; не успеваем к отгрузке — сдвигаем на сегодня и помечаем.
  • план хранится слотами «строка × день × штуки» (PlanSlot): расчёт
    ставит автоматические, планировщик правит вручную — пересчёт ручные
    не трогает.
Мощность участков пока не задаётся (решение пользователя)."""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.dictionaries import Part, PartStage
from app.models.items import Item, ItemComponent
from app.models.production import PlanSlot, ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.production_orders import ProductionOrder, ProductionOrderLine

FAR_AHEAD_WORKDAYS = 250  # опорная дата, когда отгрузка не задана
MAX_DEPTH = 6


# ─── рабочие дни ──────────────────────────────────────────────────────────


def is_workday(d: date) -> bool:
    return d.weekday() < 5


def to_workday(d: date, forward: bool = True) -> date:
    step = timedelta(days=1 if forward else -1)
    while not is_workday(d):
        d += step
    return d


def add_workdays(d: date, n: int) -> date:
    """n рабочих дней вперёд (n < 0 — назад) от рабочего дня d."""
    step = timedelta(days=1 if n >= 0 else -1)
    d = to_workday(d, forward=n >= 0)
    for _ in range(abs(n)):
        d += step
        while not is_workday(d):
            d += step
    return d


def workdays_between(a: date, b: date) -> int:
    """Сколько рабочих дней от a до b (b позже — положительно)."""
    if a == b:
        return 0
    sign = 1 if b > a else -1
    lo, hi = (a, b) if b > a else (b, a)
    n, d = 0, lo
    while d < hi:
        d += timedelta(days=1)
        if is_workday(d):
            n += 1
    return sign * n


# ─── п/ф под заказ ────────────────────────────────────────────────────────


@dataclass
class PfNeed:
    order_line_id: int
    part_id: int
    part_name: str
    quantity: float
    consumer_stage_id: int  # операция, на которой расходуется
    consumer_part_id: int | None  # None — расходуется дверью (строкой заказа)
    depth: int
    free_stock: float = 0.0
    lamination_area: str | None = None
    factory_area: str | None = None
    factory_min_pieces: float | None = None


def _pf_components(db: Session, item: Item) -> list[tuple[Part, float, int]]:
    """Комплектующие п/ф позиции: (деталь с маршрутом, норма, операция расхода)."""
    first = min(item.stages, key=lambda s: s.sequence_order) if item.stages else None
    out = []
    for c in db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id).order_by(ItemComponent.sort_order):
        part = db.query(Part).filter(Part.item_id == c.component_item_id, Part.is_active.is_(True)).first()
        if part is None or not part.stages:
            continue  # материал или деталь без маршрута — не запускается заданием
        stage_id = c.stage_id or (first.id if first else None)
        if stage_id is None:
            continue
        out.append((part, float(c.qty_per_unit), stage_id))
    return out


def order_pf_needs(db: Session, order: ProductionOrder) -> list[PfNeed]:
    """Что из п/ф запустить под заказ — по составу вглубь, на полное
    количество заказа (п/ф щитовых делаются под заказ)."""
    from app.services.panel_film import FACTORY_AREA, FACTORY_MIN_PANELS, LAMINATION_STAGE
    from app.services.pf_demand import _stock_by_part  # noqa: PLC2701 — тот же расчёт остатка

    stock = _stock_by_part(db)
    out: list[PfNeed] = []

    def walk(order_line_id: int, item: Item, qty: float, consumer_part_id: int | None, depth: int) -> None:
        if depth > MAX_DEPTH:
            return
        for part, per, stage_id in _pf_components(db, item):
            need = round(qty * per, 2)
            if need <= 0:
                continue
            lam = next((s for s in part.stages if s.name == LAMINATION_STAGE), None)
            out.append(
                PfNeed(
                    order_line_id=order_line_id, part_id=part.id, part_name=part.name, quantity=need,
                    consumer_stage_id=stage_id, consumer_part_id=consumer_part_id, depth=depth,
                    free_stock=round(stock.get(part.id, 0.0), 2),
                    lamination_area=lam.area if lam else None,
                    factory_area=FACTORY_AREA if lam else None,
                    factory_min_pieces=FACTORY_MIN_PANELS if lam else None,
                )
            )
            if part.item_id:
                walk(order_line_id, db.get(Item, part.item_id), need, part.id, depth + 1)

    for ln in order.lines:
        walk(ln.id, db.get(Item, ln.item_id), float(ln.quantity), None, 0)
    return out


@dataclass
class PfPick:
    order_line_id: int
    part_id: int
    quantity: float
    consumer_part_id: int | None = None
    lamination_area: str | None = None


def release_pf(
    db: Session, order: ProductionOrder, door_tasks: list[ProductionTask], picks: list[PfPick], user_id: int
) -> list[ProductionTask]:
    """Задания на п/ф под заказ (без commit): задание на участок, строка на
    операцию маршрута детали (кроме последнего этапа — готовая деталь);
    строки помнят строку заказа; задание — «под» задание, где деталь
    расходуется (сделанное уходит в его резерв)."""
    from app.services.panel_film import LAMINATION_STAGE

    area_names = {a.code: a.name for a in db.query(Area)}
    # (строка заказа, этап) → задание, где этот этап выполняется
    stage_task: dict[tuple[int, int], ProductionTask] = {}
    for t in door_tasks:
        for ln in t.lines:
            if ln.order_line_id and ln.part_stage_id:
                stage_task[(ln.order_line_id, ln.part_stage_id)] = t
    tasks: dict[tuple[str, int | None], ProductionTask] = {}
    consumer_stage = {
        (n.order_line_id, n.part_id, n.consumer_part_id): n.consumer_stage_id for n in order_pf_needs(db, order)
    }
    # Сначала верхний уровень — чтобы у вложенных было «под» какое задание.
    for pick in sorted(picks, key=lambda p: 0 if p.consumer_part_id is None else 1):
        if pick.quantity <= 0:
            continue
        part = db.get(Part, pick.part_id)
        if part is None or not part.stages:
            continue
        stages = sorted(part.stages, key=lambda s: s.sequence_order)
        ops = stages[:-1] if len(stages) > 1 else stages
        cs = consumer_stage.get((pick.order_line_id, pick.part_id, pick.consumer_part_id))
        for_task = stage_task.get((pick.order_line_id, cs)) if cs else None
        for stage in ops:
            area = stage.area
            if pick.lamination_area and stage.name == LAMINATION_STAGE:
                area = pick.lamination_area
            if area is None:
                continue
            key = (area, for_task.id if for_task else None)
            task = tasks.get(key)
            if task is None:
                task = ProductionTask(
                    name=f"Заказ №{order.id} «{order.name}» — п/ф, {area_names.get(area, area)}"[:255],
                    area=area, created_by=user_id, production_order_id=order.id, is_active=True,
                    for_task_id=for_task.id if for_task else None,
                )
                db.add(task)
                tasks[key] = task
            line = ProductionTaskLine(
                quantity_pieces=pick.quantity, part_stage_id=stage.id, part_id=part.id, part_name=part.name,
                width_mm=float(part.width_mm or 0), length_m=0, order_line_id=pick.order_line_id,
            )
            task.lines.append(line)
            db.flush()
            stage_task[(pick.order_line_id, stage.id)] = task
    db.flush()
    return list(tasks.values())


# ─── сроки ────────────────────────────────────────────────────────────────


@dataclass
class ScheduleResult:
    finish: date | None
    late: bool
    shifted_days: int = 0
    dates: dict[int, date] = field(default_factory=dict)  # строка задания → день


def _good_by_line(db: Session, line_ids: list[int]) -> dict[int, float]:
    if not line_ids:
        return {}
    return {
        lid: float(g)
        for lid, g in db.query(ProductionTaskLineReport.task_line_id, func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
        .filter(ProductionTaskLineReport.task_line_id.in_(line_ids), ProductionTaskLineReport.counts_toward_line.is_(True))
        .group_by(ProductionTaskLineReport.task_line_id)
    }


def schedule_order(db: Session, order: ProductionOrder, user_id: int, today: date | None = None) -> ScheduleResult:
    """Расставить сроки строк заданий заказа (без commit) и записать
    автоматические слоты плана на невыполненный остаток."""
    today = to_workday(today or date.today())
    tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id).all()
    lines = [ln for t in tasks for ln in t.lines]
    if not lines:
        return ScheduleResult(finish=None, late=False)
    lead = {a.code: max(0, int(a.lead_days or 0)) for a in db.query(Area)}
    stage_of = {s.id: s for s in db.query(PartStage).filter(PartStage.id.in_({ln.part_stage_id for ln in lines if ln.part_stage_id}))}
    task_of = {ln.id: t for t in tasks for ln in t.lines}
    anchor = order.ship_date and add_workdays(to_workday(order.ship_date, forward=False), 0)
    last_day = add_workdays(anchor, -1) if anchor else add_workdays(today, FAR_AHEAD_WORKDAYS)

    dates: dict[int, date] = {}
    # Строки по (строка заказа, деталь или дверь) — цепочки операций.
    chains: dict[tuple[int | None, int | None], list[ProductionTaskLine]] = defaultdict(list)
    for ln in lines:
        stage = stage_of.get(ln.part_stage_id) if ln.part_stage_id else None
        owner = stage.part_id if stage is not None and stage.part_id else None  # None — дверь (позиция заказа)
        chains[(ln.order_line_id, owner)].append(ln)
    for chain in chains.values():
        chain.sort(key=lambda ln: stage_of[ln.part_stage_id].sequence_order if ln.part_stage_id in stage_of else 0)

    def place_chain(chain: list[ProductionTaskLine], end: date) -> None:
        d = end
        for i in range(len(chain) - 1, -1, -1):
            ln = chain[i]
            dates[ln.id] = d
            d = add_workdays(d, -max(1, lead.get(task_of[ln.id].area, 1)))

    # Двери и строки без операций — от последнего дня.
    for (ol, owner), chain in chains.items():
        if owner is None:
            place_chain(chain, last_day)
    # П/ф — к операции, на которой расходуются; вложенные — после своих родителей.
    parts = {p.id: p for p in db.query(Part).filter(Part.id.in_({o for _, o in chains if o}))}
    pending = [(ol, owner) for ol, owner in chains if owner is not None]
    for _ in range(MAX_DEPTH + 1):
        rest = []
        for ol, owner in pending:
            part = parts.get(owner)
            comp = (
                db.query(ItemComponent).filter(ItemComponent.component_item_id == part.item_id).all() if part and part.item_id else []
            )
            consumer_dates = []
            for c in comp:
                for ln in lines:
                    if ln.order_line_id != ol or ln.id not in dates:
                        continue
                    st = stage_of.get(ln.part_stage_id)
                    if st is None or st.item_id != c.parent_item_id:
                        continue
                    first = min(st.item.stages, key=lambda s: s.sequence_order).id if st.item and st.item.stages else st.id
                    if (c.stage_id or first) == st.id:
                        consumer_dates.append(dates[ln.id])
            if consumer_dates:
                chain = chains[(ol, owner)]
                end = add_workdays(min(consumer_dates), -max(1, lead.get(task_of[chain[-1].id].area, 1)))
                place_chain(chain, end)
            elif any(ln.id not in dates for ln in chains[(ol, owner)]):
                rest.append((ol, owner))
        if not rest or rest == pending:
            for ol, owner in rest:  # потребитель не нашёлся — к последнему дню
                place_chain(chains[(ol, owner)], add_workdays(last_day, -1))
            break
        pending = rest

    # Не успеваем (или отгрузки нет) — сдвиг вперёд до сегодня.
    earliest = min(dates.values())
    shift = workdays_between(earliest, today) if earliest < today or not anchor else 0
    if shift:
        dates = {k: add_workdays(v, shift) for k, v in dates.items()}
    finish = max(dates.values())
    late = bool(anchor and finish >= anchor)

    good = _good_by_line(db, [ln.id for ln in lines])
    manual = defaultdict(float)
    for s in db.query(PlanSlot).filter(PlanSlot.task_line_id.in_([ln.id for ln in lines])):
        if s.auto:
            db.delete(s)
        else:
            manual[s.task_line_id] += float(s.quantity)
    db.flush()
    for ln in lines:
        left = float(ln.quantity_pieces) - good.get(ln.id, 0.0) - manual[ln.id]
        if left > 0 and not (ln.is_closed or ln.production_closed):
            db.add(PlanSlot(task_line_id=ln.id, date=dates[ln.id], quantity=round(left, 2), auto=True, created_by=user_id))
    db.flush()
    return ScheduleResult(finish=finish, late=late, shifted_days=shift, dates=dates)


@dataclass
class OrderPlanStatus:
    finish: date | None  # последний день плана
    late: bool  # план кончается не раньше дня отгрузки
    overdue: float  # штук в прошедших днях плана, ещё не сделанных
    planned: bool


def order_plan_status(db: Session, order: ProductionOrder, today: date | None = None) -> OrderPlanStatus:
    today = today or date.today()
    line_ids = [
        ln.id
        for t in db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id)
        for ln in t.lines
    ]
    slots = db.query(PlanSlot).filter(PlanSlot.task_line_id.in_(line_ids)).all() if line_ids else []
    if not slots:
        return OrderPlanStatus(finish=None, late=False, overdue=0.0, planned=False)
    finish = max(s.date for s in slots)
    # Просрочено: запланированное на прошедшие дни сверх уже сделанного.
    good = _good_by_line(db, line_ids)
    past = defaultdict(float)
    for s in slots:
        if s.date < today:
            past[s.task_line_id] += float(s.quantity)
    overdue = sum(max(0.0, q - good.get(lid, 0.0)) for lid, q in past.items())
    return OrderPlanStatus(
        finish=finish, late=bool(order.ship_date and finish >= order.ship_date), overdue=round(overdue, 2), planned=True
    )
