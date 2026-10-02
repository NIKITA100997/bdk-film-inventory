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
    free_stock: float = 0.0  # свободно (остаток минус чужие резервы) на момент этой строки
    from_stock: float = 0.0  # предложено взять со склада (в резерв под заказ)
    launch: float = 0.0  # предложено запустить в производство
    mode: str | None = None  # под заказ / на склад (services/item_attrs.py)
    lamination_area: str | None = None
    factory_area: str | None = None
    factory_min_pieces: float | None = None


def _pf_components(db: Session, item: Item) -> list[tuple[Part, float, int]]:
    """Комплектующие п/ф позиции: (деталь с маршрутом, норма, операция расхода)."""
    first = min(item.stages, key=lambda s: s.sequence_order) if item.stages else None
    out = []
    from app.services.components import planned_components

    for c in planned_components(db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id).all()):
        part = db.query(Part).filter(Part.item_id == c.component_item_id, Part.is_active.is_(True)).first()
        if part is None or not part.stages:
            continue  # материал или деталь без маршрута — не запускается заданием
        stage_id = c.stage_id or (first.id if first else None)
        if stage_id is None:
            continue
        out.append((part, float(c.qty_per_unit), stage_id))
    return out


def order_pf_needs(db: Session, order: ProductionOrder) -> list[PfNeed]:
    """Что из п/ф нужно заказу — по составу вглубь (как MRP). Свободный
    остаток (минус резервы других заданий) — общий на весь заказ: деталь
    «на склад» по умолчанию берётся со склада, недостающее — в запуск;
    «под заказ» (щиты, панели, детали в плёнке) — по умолчанию запуск на всё.
    Вложенные п/ф считаются от запускаемого количества: что взяли со склада
    готовым, заново из комплектующих не делается."""
    from app.models.items import ItemKind, ItemType
    from app.services import item_attrs
    from app.services.panel_film import FACTORY_AREA, FACTORY_MIN_PANELS, LAMINATION_STAGE
    from app.services.pf_demand import _state  # noqa: PLC2701 — остаток и резервы, как на экранах

    st = _state(db)
    pool = {pid: max(0.0, qty - st.reserved.get(pid, 0.0)) for pid, qty in st.stock.items()}
    kind_code = {k.id: k.code for k in db.query(ItemKind)}
    out: list[PfNeed] = []

    def mode_of(part: Part) -> str | None:
        it = db.get(Item, part.item_id) if part.item_id else None
        if it is None:
            return None
        t = db.get(ItemType, it.type_id) if it.type_id else None
        return item_attrs.effective_mode(it, kind_code.get(it.kind_id, ""), t)

    def walk(order_line_id: int, item: Item, qty: float, consumer_part_id: int | None, depth: int) -> None:
        if depth > MAX_DEPTH:
            return
        for part, per, stage_id in _pf_components(db, item):
            need = round(qty * per, 2)
            if need <= 0:
                continue
            mode = mode_of(part)
            free = pool.get(part.id, 0.0)
            take = round(min(need, free), 2) if mode == "stock" else 0.0
            pool[part.id] = free - take
            launch = round(need - take, 2)
            lam = next((s for s in part.stages if s.name == LAMINATION_STAGE), None)
            out.append(
                PfNeed(
                    order_line_id=order_line_id, part_id=part.id, part_name=part.name, quantity=need,
                    consumer_stage_id=stage_id, consumer_part_id=consumer_part_id, depth=depth,
                    free_stock=round(free, 2), from_stock=take, launch=launch, mode=mode,
                    lamination_area=lam.area if lam else None,
                    factory_area=FACTORY_AREA if lam else None,
                    factory_min_pieces=FACTORY_MIN_PANELS if lam else None,
                )
            )
            if part.item_id and launch > 0:
                walk(order_line_id, db.get(Item, part.item_id), launch, part.id, depth + 1)

    for ln in order.lines:
        walk(ln.id, db.get(Item, ln.item_id), float(ln.quantity), None, 0)
    return out


@dataclass
class PfPick:
    order_line_id: int
    part_id: int
    quantity: float  # запустить в производство
    consumer_part_id: int | None = None
    lamination_area: str | None = None
    from_stock: float = 0.0  # взять со склада — резерв под задание, где деталь расходуется


def release_pf(
    db: Session, order: ProductionOrder, door_tasks: list[ProductionTask], picks: list[PfPick], user_id: int
) -> list[ProductionTask]:
    """Задания на п/ф под заказ (без commit): задание на участок, строка на
    операцию маршрута детали (кроме последнего этапа — готовая деталь);
    строки помнят строку заказа; задание — «под» задание, где деталь
    расходуется (сделанное уходит в его резерв)."""
    from app.services.panel_film import LAMINATION, LAMINATION_STAGE, lamination_line_film

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
        part = db.get(Part, pick.part_id)
        if part is None or not part.stages:
            continue
        cs = consumer_stage.get((pick.order_line_id, pick.part_id, pick.consumer_part_id))
        for_task = stage_task.get((pick.order_line_id, cs)) if cs else None
        if pick.from_stock > 0 and for_task is not None:
            _reserve(db, task_id=for_task.id, part_id=part.id, quantity=pick.from_stock, user_id=user_id)
        if pick.quantity <= 0:
            continue
        stages = sorted(part.stages, key=lambda s: s.sequence_order)
        ops = stages[:-1] if len(stages) > 1 else stages
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
            # Ламинация/окутка панели — строка с плёнкой: склад выдаёт под неё
            # штрипс (Фабрика) или рулон целиком (прессы режут сами), отчёт
            # списывает метраж (02.10).
            film = lamination_line_film(db, part, stage, area) if stage.name in LAMINATION else {}
            line = ProductionTaskLine(
                quantity_pieces=pick.quantity, part_stage_id=stage.id, part_id=part.id, part_name=part.name,
                width_mm=float(part.width_mm or 0), length_m=film.pop("length_m", 0), order_line_id=pick.order_line_id,
                **film,
            )
            task.lines.append(line)
            db.flush()
            stage_task[(pick.order_line_id, stage.id)] = task
    db.flush()
    return list(tasks.values())


def _reserve(db: Session, *, task_id: int, part_id: int, quantity: float, user_id: int) -> None:
    """Со склада — в резерв под задание, где деталь расходуется (тот же
    резерв, что «Обеспечение п/ф»: чужой резерв расходовать нельзя)."""
    from app.models.part_units import PartReservation

    r = db.query(PartReservation).filter(PartReservation.task_id == task_id, PartReservation.part_id == part_id).first()
    if r is None:
        db.add(PartReservation(task_id=task_id, part_id=part_id, quantity_pieces=quantity, created_by=user_id))
    else:
        r.quantity_pieces = float(r.quantity_pieces) + quantity
    db.flush()


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


ChainKey = tuple[int | None, int | None]  # (строка заказа, деталь п/ф или None — сама позиция заказа)


@dataclass
class OrderChains:
    """Связи операций заказа: цепочки операций по порядку маршрута и для
    цепочки п/ф — строки, где эта деталь расходуется (её «следующий этап»)."""

    lines: list[ProductionTaskLine]
    task_of: dict[int, ProductionTask]
    stage_of: dict[int, PartStage]
    chains: dict[ChainKey, list[ProductionTaskLine]]
    consumers: dict[ChainKey, list[int]]


def order_chains(db: Session, order: ProductionOrder) -> OrderChains:
    tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id).all()
    lines = [ln for t in tasks for ln in t.lines]
    stage_of = {
        s.id: s for s in db.query(PartStage).filter(PartStage.id.in_({ln.part_stage_id for ln in lines if ln.part_stage_id}))
    } if lines else {}
    task_of = {ln.id: t for t in tasks for ln in t.lines}
    chains: dict[ChainKey, list[ProductionTaskLine]] = defaultdict(list)
    for ln in lines:
        stage = stage_of.get(ln.part_stage_id) if ln.part_stage_id else None
        owner = stage.part_id if stage is not None and stage.part_id else None
        chains[(ln.order_line_id, owner)].append(ln)
    for chain in chains.values():
        chain.sort(key=lambda ln: stage_of[ln.part_stage_id].sequence_order if ln.part_stage_id in stage_of else 0)
    parts = {p.id: p for p in db.query(Part).filter(Part.id.in_({o for _, o in chains if o}))} if chains else {}
    consumers: dict[ChainKey, list[int]] = {}
    for (ol, owner) in chains:
        if owner is None:
            continue
        part = parts.get(owner)
        comps = db.query(ItemComponent).filter(ItemComponent.component_item_id == part.item_id).all() if part and part.item_id else []
        found = []
        for c in comps:
            for ln in lines:
                if ln.order_line_id != ol:
                    continue
                st = stage_of.get(ln.part_stage_id)
                if st is None or st.item_id != c.parent_item_id:
                    continue
                first = min(st.item.stages, key=lambda x: x.sequence_order).id if st.item and st.item.stages else st.id
                if (c.stage_id or first) == st.id:
                    found.append(ln.id)
        consumers[(ol, owner)] = found
    return OrderChains(lines=lines, task_of=task_of, stage_of=stage_of, chains=dict(chains), consumers=consumers)


def order_edges(oc: OrderChains) -> list[tuple[int, int]]:
    """(предыдущая строка, следующая строка): соседние операции цепочки и
    последняя операция п/ф → операция, где деталь расходуется."""
    edges = []
    for key, chain in oc.chains.items():
        for a, b in zip(chain, chain[1:]):
            edges.append((a.id, b.id))
        if chain and key[1] is not None:
            edges.extend((chain[-1].id, c) for c in oc.consumers.get(key, []))
    return edges


def schedule_order(db: Session, order: ProductionOrder, user_id: int, today: date | None = None) -> ScheduleResult:
    """Расставить сроки строк заданий заказа (без commit) и записать
    автоматические слоты плана на невыполненный остаток."""
    today = to_workday(today or date.today())
    oc = order_chains(db, order)
    lines, stage_of, task_of, chains = oc.lines, oc.stage_of, oc.task_of, oc.chains
    if not lines:
        return ScheduleResult(finish=None, late=False)
    lead = {a.code: max(0, int(a.lead_days or 0)) for a in db.query(Area)}
    anchor = order.ship_date and add_workdays(to_workday(order.ship_date, forward=False), 0)
    last_day = add_workdays(anchor, -1) if anchor else add_workdays(today, FAR_AHEAD_WORKDAYS)

    dates: dict[int, date] = {}

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
    pending = [(ol, owner) for ol, owner in chains if owner is not None]
    for _ in range(MAX_DEPTH + 1):
        rest = []
        for ol, owner in pending:
            consumer_dates = [dates[x] for x in oc.consumers.get((ol, owner), []) if x in dates]
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


# ─── связанные этапы при переносе ─────────────────────────────────────────


@dataclass
class MoveConflict:
    line_id: int
    what: str
    operation: str | None
    area: str
    relation: str  # "next" — следующий этап окажется не позже; "prev" — предыдущий не раньше
    start: date
    end: date
    need: date  # следующий — не раньше этого дня; предыдущий — не позже


def _windows(slots: list[PlanSlot]) -> dict[int, tuple[date, date]]:
    w: dict[int, tuple[date, date]] = {}
    for sl in slots:
        a, b = w.get(sl.task_line_id, (sl.date, sl.date))
        w[sl.task_line_id] = (min(a, sl.date), max(b, sl.date))
    return w


def _orders_of_lines(db: Session, line_ids: set[int]) -> list[ProductionOrder]:
    ids = {
        t.production_order_id
        for t in db.query(ProductionTask).join(ProductionTaskLine, ProductionTaskLine.task_id == ProductionTask.id)
        .filter(ProductionTaskLine.id.in_(line_ids))
        if t.production_order_id
    }
    return db.query(ProductionOrder).filter(ProductionOrder.id.in_(ids)).all() if ids else []


def check_move(db: Session, changes: list[tuple[int, int | None, date]]) -> list[MoveConflict]:
    """Проверить перенос без записи. changes — (строка, слот или None для
    нового слота при делении, новый день). Правило: следующий этап — не
    раньше следующего рабочего дня после конца предыдущего."""
    line_ids = {ln for ln, _, _ in changes}
    conflicts: list[MoveConflict] = []
    for order in _orders_of_lines(db, line_ids):
        oc = order_chains(db, order)
        all_ids = [ln.id for ln in oc.lines]
        slots = db.query(PlanSlot).filter(PlanSlot.task_line_id.in_(all_ids)).all()
        virtual = [PlanSlot(task_line_id=sl.task_line_id, date=sl.date, quantity=sl.quantity) for sl in slots]
        by_id = {sl.id: v for sl, v in zip(slots, virtual)}
        for ln, slot_id, d in changes:
            if slot_id is not None and slot_id in by_id:
                by_id[slot_id].date = d
            elif slot_id is None:
                virtual.append(PlanSlot(task_line_id=ln, date=d, quantity=0))
        w = _windows(virtual)
        names = {ln.id: ln for ln in oc.lines}
        seen = set()
        for a, b in order_edges(oc):
            if a not in w or b not in w or (a not in line_ids and b not in line_ids):
                continue
            if w[b][0] > w[a][1]:
                continue
            if a in line_ids and b not in line_ids:  # сдвинули предыдущий — страдает следующий
                other, rel, need = b, "next", add_workdays(w[a][1], 1)
            elif b in line_ids and a not in line_ids:  # сдвинули следующий раньше предыдущего
                other, rel, need = a, "prev", add_workdays(w[b][0], -1)
            else:
                continue
            if (other, rel) in seen:
                continue
            seen.add((other, rel))
            ln = names[other]
            st = oc.stage_of.get(ln.part_stage_id)
            conflicts.append(
                MoveConflict(
                    line_id=other, what=ln.part_name or "—", operation=st.name if st else None,
                    area=oc.task_of[other].area, relation=rel, start=w[other][0], end=w[other][1], need=need,
                )
            )
    return conflicts


def shift_following(db: Session, moved_line_ids: set[int]) -> int:
    """После переноса сдвинуть следующие этапы (и дальше по цепочке) так,
    чтобы каждый шёл не раньше следующего рабочего дня после предыдущего.
    Сдвинутые слоты становятся ручными. Возвращает число сдвинутых строк."""
    shifted = 0
    for order in _orders_of_lines(db, moved_line_ids):
        oc = order_chains(db, order)
        slots = db.query(PlanSlot).filter(PlanSlot.task_line_id.in_([ln.id for ln in oc.lines])).all()
        by_line: dict[int, list[PlanSlot]] = defaultdict(list)
        for sl in slots:
            by_line[sl.task_line_id].append(sl)
        succ: dict[int, list[int]] = defaultdict(list)
        for a, b in order_edges(oc):
            succ[a].append(b)
        queue = [ln for ln in moved_line_ids if ln in by_line]
        guard = 0
        while queue and guard < 500:
            guard += 1
            a = queue.pop(0)
            end_a = max(sl.date for sl in by_line[a])
            for b in succ.get(a, []):
                if not by_line.get(b):
                    continue
                start_b = min(sl.date for sl in by_line[b])
                need = add_workdays(end_a, 1)
                if start_b >= need:
                    continue
                delta = workdays_between(start_b, need)
                for sl in by_line[b]:
                    sl.date = add_workdays(sl.date, delta)
                    sl.auto = False
                shifted += 1
                queue.append(b)
    db.flush()
    return shifted


def set_task_date(db: Session, task: ProductionTask, day: date, user_id: int, shift_next: bool = True) -> int:
    """Ручной срок этапа (02.10): всё несделанное по строкам задания — на
    один день (ручной слот, пересчёт сроков его не трогает); следующие
    этапы заказа при желании сдвигаются так, чтобы шли после него.
    Возвращает число строк, поставленных на дату."""
    day = to_workday(day)
    lines = [ln for ln in task.lines if not ln.production_closed]
    good = _good_by_line(db, [ln.id for ln in lines])
    moved: set[int] = set()
    for ln in lines:
        db.query(PlanSlot).filter(PlanSlot.task_line_id == ln.id).delete(synchronize_session=False)
        rest = max(0.0, float(ln.quantity_pieces) - good.get(ln.id, 0.0))
        if rest > 0:
            db.add(PlanSlot(task_line_id=ln.id, date=day, quantity=round(rest, 2), auto=False, created_by=user_id))
            moved.add(ln.id)
    db.flush()
    if shift_next and moved:
        shift_following(db, moved)
    return len(moved)


def shift_order(db: Session, order: ProductionOrder, days: int) -> int:
    """Сдвинуть весь план заказа на days рабочих дней (вперёд или назад);
    сдвинутые слоты становятся ручными. Возвращает число слотов."""
    if not days:
        return 0
    line_ids = [
        ln.id
        for t in db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id)
        for ln in t.lines
    ]
    n = 0
    for sl in db.query(PlanSlot).filter(PlanSlot.task_line_id.in_(line_ids or [0])):
        sl.date = add_workdays(sl.date, days)
        sl.auto = False
        n += 1
    db.flush()
    return n
