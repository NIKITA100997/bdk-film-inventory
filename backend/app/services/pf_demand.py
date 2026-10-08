"""Потребность в производстве п/ф (раздел про минимальные остатки п/ф).

  нужно      = остаток плана по открытым заданиям цеха на деталь
               (сколько ещё окутать) + минимальный остаток детали;
  есть       = живые партии детали на любом этапе (кроме списанных и
               отложенных в переработку) + ещё не сделанное по открытым
               заданиям участкам на первый этап детали («в работе»);
  не хватает = нужно − есть;
  произвести = не хватает, но не меньше минимальной партии.

Задание участку создаёт начальник кнопкой — предложение, не автоматика.

Резерв на задание (как обеспечение заказа в 1С): часть остатка закреплена
за заданием цеха — явный резерв (PartReservation) плюс сделанное по
заданиям п/ф «под это задание» (ProductionTask.for_task_id), не больше
остатка задания по детали. Остаток распределяется по резервам от старых
заданий к новым; «свободно» = остаток − обеспеченные резервы. Чужой
резерв расходовать нельзя (check_foreign_reserve): отчёт другого задания
или расход без задания, который залезает в него, не принимается."""

from collections import defaultdict
from dataclasses import dataclass, replace

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.dictionaries import Part, PartStage
from app.models.part_units import PartReservation, PartUnit, PartUnitStatus
from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.services import normatives
from app.services.part_units import reported_good_pieces_by_unit


@dataclass(frozen=True)
class PfDemandSource:
    """Задание цеха, из которого набралась потребность детали."""

    task_id: int
    task_name: str
    open_plan: float
    done: float
    remaining: float
    reserve_set: float = 0.0  # явный резерв, как его ввели
    reserved: float = 0.0  # обеспечено остатком (резерв + сделанное под задание)
    in_work: float = 0.0  # производится под задание
    shortage: float = 0.0  # не обеспечено ни резервом, ни производством


@dataclass(frozen=True)
class PfDemandRow:
    part_id: int
    part_name: str
    min_stock: float | None
    min_batch: float | None
    batch_multiple: float | None
    task_demand: float
    stock: float
    in_work: float
    need: float
    shortage: float
    suggested: float
    first_stage_id: int
    first_stage_name: str
    first_stage_area: str | None
    sources: list[PfDemandSource]
    reserved: float = 0.0  # остатка в резерве под задания
    free: float = 0.0  # остаток без резервов
    item_id: int | None = None  # позиция номенклатуры — у неё нормативы


def compute_suggestion(
    *, task_demand: float, min_stock: float | None, stock: float, in_work: float, min_batch: float | None,
    batch_multiple: float | None = None,
) -> tuple[float, float, float]:
    """(нужно, не хватает, произвести) — общий расчёт нормативов
    (services/normatives.py), как у плёнки и материалов."""
    return normatives.suggest(
        demand=task_demand, have=stock + in_work, norms=normatives.Norms(min_stock, min_batch, batch_multiple)
    )


def part_norms(p: Part) -> "normatives.Norms":
    """Нормативы детали — у её позиции номенклатуры (с 08.10)."""
    return normatives.norms_of(p.item)


def task_part_remaining(lines: list[tuple[float, float, bool]]) -> float:
    """Сколько ещё нужно сделать детали по одному заданию цеха — по всем её
    строкам в задании вместе (план, сделано, строка закрыта). Мастер
    отчитывается за общий штрипс по одной строке, поэтому одни строки
    перевыполнены, а соседние той же детали стоят на нуле — построчно это
    выглядело бы как потребность. Закрытая строка (выдача или производство
    закрыты) из плана выпадает, но сделанное по ней сверх её плана
    засчитывается соседним."""
    open_plan = sum(plan for plan, _, closed in lines if not closed)
    credited = sum(good for _, good, _ in lines) - sum(min(good, plan) for plan, good, closed in lines if closed)
    return max(0.0, open_plan - credited)


def _task_demand_by_part(db: Session) -> dict[int, list[PfDemandSource]]:
    query = (
        db.query(ProductionTaskLine)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        # Строки-операции (сделать деталь) — не потребность, а «в работе»,
        # см. _in_work_by_first_stage; потребность — строки, расходующие п/ф.
        .filter(
            ProductionTask.is_active.is_(True),
            ProductionTaskLine.part_name.isnot(None),
            ProductionTaskLine.part_stage_id.is_(None),
        )
    )
    lines = query.all()
    if not lines:
        return {}
    good = dict(
        db.query(ProductionTaskLineReport.task_line_id, func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
        .filter(
            ProductionTaskLineReport.task_line_id.in_([line.id for line in lines]),
            ProductionTaskLineReport.counts_toward_line.is_(True),
        )
        .group_by(ProductionTaskLineReport.task_line_id)
        .all()
    )
    # Раздел про единую номенклатуру — деталь строки по ссылке; строки без
    # ссылки (название не совпало ни с одной деталью) в потребность не идут,
    # они видны в «Номенклатура → Строки без детали».
    by_task_part: dict[tuple[int, int], list[tuple[float, float, bool]]] = defaultdict(list)
    for line in lines:
        if line.part_id is None:
            continue
        by_task_part[(line.task_id, line.part_id)].append(
            (float(line.quantity_pieces), float(good.get(line.id, 0)), line.is_closed or line.production_closed)
        )
    tasks = {line.task_id: line.task for line in lines}
    demand: dict[int, list[PfDemandSource]] = defaultdict(list)
    for (task_id, part_id), part_lines in by_task_part.items():
        remaining = task_part_remaining(part_lines)
        if remaining <= 0:
            continue
        task = tasks[task_id]
        demand[part_id].append(
            PfDemandSource(
                task_id=task_id,
                task_name=(task.product_model.name if task.product_model else None) or task.name or f"Задание №{task_id}",
                open_plan=sum(plan for plan, _, closed in part_lines if not closed),
                done=sum(good for _, good, _ in part_lines),
                remaining=remaining,
            )
        )
    return demand


def _stock_by_part(db: Session) -> dict[int, float]:
    units = (
        db.query(PartUnit)
        .filter(PartUnit.status.in_([PartUnitStatus.NA_KHRANENII, PartUnitStatus.VYDAN_UCHASTKU]))
        .all()
    )
    reported = reported_good_pieces_by_unit(db, [u.id for u in units])
    stock: dict[int, float] = defaultdict(float)
    for u in units:
        stock[u.part_id] += max(0.0, float(u.quantity_pieces) - reported.get(u.id, 0.0))
    return stock


def _first_stage_work(
    db: Session, first_stage_ids: set[int]
) -> tuple[dict[int, float], dict[tuple[int, int], list[float]]]:
    """(в работе по первому этапу — всё; {(задание-получатель, деталь):
    [сделано, в работе]} — по заданиям п/ф «под задание»). Сделанное
    считается и у архивного задания п/ф: детали уже родились под задание."""
    if not first_stage_ids:
        return {}, {}
    lines = (
        db.query(ProductionTaskLine)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(
            or_(ProductionTask.is_active.is_(True), ProductionTask.for_task_id.isnot(None)),
            ProductionTaskLine.part_stage_id.in_(first_stage_ids),
        )
        .all()
    )
    if not lines:
        return {}, {}
    good = dict(
        db.query(ProductionTaskLineReport.task_line_id, func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
        .filter(
            ProductionTaskLineReport.task_line_id.in_([line.id for line in lines]),
            ProductionTaskLineReport.counts_toward_line.is_(True),
        )
        .group_by(ProductionTaskLineReport.task_line_id)
        .all()
    )
    in_work: dict[int, float] = defaultdict(float)
    linked: dict[tuple[int, int], list[float]] = defaultdict(lambda: [0.0, 0.0])
    for line in lines:
        made = float(good.get(line.id, 0))
        left = max(0.0, float(line.quantity_pieces) - made) if line.task.is_active else 0.0
        in_work[line.part_stage_id] += left
        if line.task.for_task_id is not None and line.part_id is not None:
            acc = linked[(line.task.for_task_id, line.part_id)]
            acc[0] += made
            acc[1] += left
    return in_work, linked


def allocate_reserves(
    stock: float, wants: list[tuple[float, float, float]]
) -> list[tuple[float, float, float]]:
    """Распределить остаток детали по заданиям (в порядке списка — от
    старых к новым). wants — (остаток задания, хочет в резерв, производится
    под задание); результат — (обеспечено остатком, в работе под задание,
    не хватает). Резерв не больше остатка задания и не больше того, что
    осталось на складе после более старых заданий."""
    left = stock
    out = []
    for remaining, want, work in wants:
        got = max(0.0, min(remaining, want, left))
        left -= got
        in_work = max(0.0, min(work, remaining - got))
        out.append((round(got, 2), round(in_work, 2), round(max(0.0, remaining - got - in_work), 2)))
    return out


def _merge_by_task(sources: list[PfDemandSource]) -> list[PfDemandSource]:
    """Одна строка на задание: у задания может быть несколько операций с
    той же деталью — резерв и нехватка считаются на задание целиком."""
    by_task: dict[int, PfDemandSource] = {}
    for s in sources:
        cur = by_task.get(s.task_id)
        by_task[s.task_id] = (
            s
            if cur is None
            else replace(
                cur, open_plan=cur.open_plan + s.open_plan, done=cur.done + s.done, remaining=cur.remaining + s.remaining
            )
        )
    return sorted(by_task.values(), key=lambda s: s.task_id)


@dataclass
class _State:
    parts: list[Part]
    first_stage: dict[int, PartStage]
    demand: dict[int, list[PfDemandSource]]  # по детали, с резервами
    stock: dict[int, float]
    reserved: dict[int, float]
    in_work: dict[int, float]  # по детали, всё
    unlinked_in_work: dict[int, float]  # по детали, не под конкретное задание


def _state(db: Session) -> _State:
    parts = [p for p in db.query(Part).filter(Part.is_active.is_(True)).all() if p.stages]
    first_stage = {p.id: min(p.stages, key=lambda s: s.sequence_order) for p in parts}
    raw = _task_demand_by_part(db)
    for part_id, sources in _operation_demand_by_part(db).items():
        raw.setdefault(part_id, []).extend(sources)
    stock = _stock_by_part(db)
    in_work_by_stage, linked = _first_stage_work(db, {s.id for s in first_stage.values()})
    reserve_set = {(r.task_id, r.part_id): float(r.quantity_pieces) for r in db.query(PartReservation)}

    demand: dict[int, list[PfDemandSource]] = {}
    reserved: dict[int, float] = defaultdict(float)
    for part_id, sources in raw.items():
        merged = _merge_by_task(sources)
        wants = []
        for s in merged:
            made, work = linked.get((s.task_id, part_id), (0.0, 0.0))
            wants.append((s.remaining, reserve_set.get((s.task_id, part_id), 0.0) + made, work))
        out = []
        for s, (got, in_work, short) in zip(merged, allocate_reserves(stock.get(part_id, 0.0), wants)):
            reserved[part_id] += got
            out.append(
                replace(s, reserve_set=reserve_set.get((s.task_id, part_id), 0.0), reserved=got, in_work=in_work, shortage=short)
            )
        demand[part_id] = out

    in_work: dict[int, float] = {}
    unlinked: dict[int, float] = {}
    for p in parts:
        w = in_work_by_stage.get(first_stage[p.id].id, 0.0)
        in_work[p.id] = w
        linked_work = sum(v[1] for (_, pid), v in linked.items() if pid == p.id)
        unlinked[p.id] = max(0.0, w - linked_work)
    return _State(parts, first_stage, demand, stock, reserved, in_work, unlinked)


def _row(st: _State, p: Part, *, sources, task_demand, stock, in_work, min_stock) -> PfDemandRow:
    fs = st.first_stage[p.id]
    norms = part_norms(p)
    min_batch = norms.min_batch
    need, shortage, suggested = compute_suggestion(
        task_demand=task_demand, min_stock=min_stock, stock=stock, in_work=in_work, min_batch=min_batch,
        batch_multiple=norms.batch_multiple,
    )
    total = st.stock.get(p.id, 0.0)
    reserved = st.reserved.get(p.id, 0.0)
    return PfDemandRow(
        part_id=p.id, part_name=p.name,
        min_stock=norms.min_stock, min_batch=min_batch, batch_multiple=norms.batch_multiple,
        task_demand=task_demand, stock=stock, in_work=in_work, need=need, shortage=shortage, suggested=suggested,
        first_stage_id=fs.id, first_stage_name=fs.name, first_stage_area=fs.area, sources=sources,
        reserved=round(reserved, 2), free=round(max(0.0, total - reserved), 2), item_id=p.item_id,
    )


def _operation_demand_by_part(db: Session) -> dict[int, list[PfDemandSource]]:
    """Потребность в комплектующих п/ф от открытых строк-операций (единая
    модель): заказов на производство (дверь → каркас, цветная панель) и
    заданий на сами п/ф (цветная панель → сырая панель) — многоуровневый
    расчёт, как MRP. Строка расходует комплектующие, которые по составу её
    позиции нужны на этой операции (компонент без операции — на первой).
    Остаток — план строки минус годные и брак по ней: на них комплектующие
    уже списаны."""
    from app.models.items import ItemComponent
    from app.models.production_orders import ProductionOrder

    out: dict[int, list[PfDemandSource]] = defaultdict(list)
    q = (
        db.query(ProductionTaskLine, ProductionTask)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTask.is_active.is_(True), ProductionTaskLine.part_stage_id.isnot(None))
    )
    rows = q.all()
    if not rows:
        return out
    parts_by_item = {p.item_id: p for p in db.query(Part).filter(Part.is_active.is_(True)) if p.stages}
    done_by_line = dict(
        db.query(
            ProductionTaskLineReport.task_line_id,
            func.coalesce(func.sum(ProductionTaskLineReport.good_pieces + ProductionTaskLineReport.defect_pieces), 0),
        )
        .filter(
            ProductionTaskLineReport.task_line_id.in_([ln.id for ln, _ in rows]),
            ProductionTaskLineReport.counts_toward_line.is_(True),
        )
        .group_by(ProductionTaskLineReport.task_line_id)
        .all()
    )
    orders = {o.id: o for o in db.query(ProductionOrder)}
    for line, task in rows:
        if line.is_closed or line.production_closed:
            continue
        stage = db.get(PartStage, line.part_stage_id)
        if stage is None:
            continue
        first_id = min(stage.item.stages, key=lambda s: s.sequence_order).id if stage.item.stages else stage.id
        from app.services.components import planned_components

        comps = [
            c for c in planned_components(db.query(ItemComponent).filter(ItemComponent.parent_item_id == stage.item_id).all())
            if c.stage_id == stage.id or (c.stage_id is None and stage.id == first_id)
        ]
        if not comps:
            continue
        done = float(done_by_line.get(line.id, 0))
        units_left = max(0.0, float(line.quantity_pieces) - done)
        if units_left <= 0:
            continue
        order = orders.get(task.production_order_id) if task.production_order_id else None
        label = f"Заказ №{order.id} «{order.name}»" if order else (task.name or f"Задание №{task.id}")
        for comp in comps:
            part = parts_by_item.get(comp.component_item_id)
            if part is None:
                continue
            per = float(comp.qty_per_unit)
            out[part.id].append(
                PfDemandSource(
                    task_id=task.id, task_name=f"{label}: {stage.name}",
                    open_plan=round(float(line.quantity_pieces) * per, 2), done=round(done * per, 2),
                    remaining=round(units_left * per, 2),
                )
            )
    return out


@dataclass(frozen=True)
class PartReserve:
    part_id: int
    stock: float
    reserved: float
    free: float
    tasks: list[PfDemandSource]  # задания с обеспеченным резервом


def reserves_by_part(db: Session) -> list[PartReserve]:
    """Резерв п/ф по деталям для экранов остатков: сколько из остатка
    закреплено за заданиями цеха (обеспечено) и сколько свободно."""
    st = _state(db)
    out = []
    for part_id, sources in st.demand.items():
        tasks = [s for s in sources if s.reserved > 0]
        if not tasks:
            continue
        stock = st.stock.get(part_id, 0.0)
        reserved = st.reserved.get(part_id, 0.0)
        out.append(PartReserve(part_id, round(stock, 2), round(reserved, 2), round(max(0.0, stock - reserved), 2), tasks))
    return out


def check_foreign_reserve(db: Session, *, part_id: int, quantity: float, task_id: int | None) -> None:
    """Запрет расходовать чужой резерв: задание task_id (None — расход без
    задания) может взять не больше остатка детали за вычетом обеспеченных
    резервов других заданий. ValueError — ничего не расходуется. Детали без
    резервов и без заданий п/ф «под задание» не проверяются вовсе."""
    if quantity <= 0:
        return
    has_reserve = db.query(PartReservation.id).filter(PartReservation.part_id == part_id).first() is not None
    has_linked = (
        db.query(ProductionTaskLine.id)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTaskLine.part_id == part_id, ProductionTask.for_task_id.isnot(None))
        .first()
        is not None
    )
    if not has_reserve and not has_linked:
        return
    db.flush()  # autoflush выключен: отчёты этой же транзакции должны быть видны
    st = _state(db)
    others = [s for s in st.demand.get(part_id, []) if s.task_id != task_id and s.reserved > 0]
    reserved = sum(s.reserved for s in others)
    if reserved <= 0:
        return
    available = st.stock.get(part_id, 0.0) - reserved
    if quantity > available + 1e-9:
        part = db.get(Part, part_id)
        tasks = ", ".join(f"№{s.task_id} ({s.reserved:g} шт)" for s in others)
        raise ValueError(
            f"«{part.name if part else part_id}»: {reserved:g} шт в резерве под задания {tasks}. "
            f"{'Этому заданию' if task_id else 'Без задания'} доступно {max(0.0, available):g} шт, нужно {quantity:g} шт — "
            f"снимите или уменьшите резерв в «Обеспечение п/ф» того задания"
        )


def compute_pf_demand(db: Session, task_ids: list[int] | None = None) -> list[PfDemandRow]:
    """Детали с этапами, у которых задан минимальный остаток, есть
    потребность по заданиям цеха или заказам на производство, или что-то в
    работе.

    task_ids — только выбранные задания цеха: «что произвести, чтобы
    закрыть именно их». Минимальный остаток тогда не добавляется (запас —
    не про конкретное задание); «есть» — свободный остаток плюс резерв этих
    заданий (резервы других заданий не в счёт), «в работе» — производимое
    под эти задания плюс запущенное без привязки к заданию; в список
    попадают только детали этих заданий."""
    st = _state(db)
    selected = set(task_ids or [])
    rows = []
    for p in st.parts:
        sources = st.demand.get(p.id, [])
        if selected:
            sources = [s for s in sources if s.task_id in selected]
            d = sum(s.remaining for s in sources)
            if d <= 0:
                continue
            free = max(0.0, st.stock.get(p.id, 0.0) - st.reserved.get(p.id, 0.0))
            stock = free + sum(s.reserved for s in sources)
            in_work = st.unlinked_in_work.get(p.id, 0.0) + sum(s.in_work for s in sources)
            rows.append(_row(st, p, sources=sources, task_demand=d, stock=stock, in_work=in_work, min_stock=None))
            continue
        d = sum(s.remaining for s in sources)
        w = st.in_work.get(p.id, 0.0)
        min_stock = part_norms(p).min_stock
        if min_stock is None and d <= 0 and w <= 0:
            continue
        rows.append(
            _row(st, p, sources=sources, task_demand=d, stock=st.stock.get(p.id, 0.0), in_work=w, min_stock=min_stock)
        )
    return sorted(rows, key=lambda r: (-r.shortage, r.part_name))


def compute_pf_preview(db: Session, items: list[tuple[int, float]]) -> list[PfDemandRow]:
    """Обеспечение п/ф ещё не созданного задания: сколько нужно по его
    строкам (деталь, шт) против свободного остатка (без резервов других
    заданий) и запущенного без привязки к заданию. Детали без этапов (п/ф не
    учитывается партиями) пропускаются."""
    st = _state(db)
    need: dict[int, float] = defaultdict(float)
    for part_id, qty in items:
        need[part_id] += qty
    rows = []
    for p in st.parts:
        if need.get(p.id, 0) <= 0:
            continue
        free = max(0.0, st.stock.get(p.id, 0.0) - st.reserved.get(p.id, 0.0))
        rows.append(
            _row(st, p, sources=[], task_demand=need[p.id], stock=free,
                 in_work=st.unlinked_in_work.get(p.id, 0.0), min_stock=None)
        )
    return sorted(rows, key=lambda r: (-r.shortage, r.part_name))
