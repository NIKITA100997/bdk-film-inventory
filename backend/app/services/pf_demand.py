"""Потребность в производстве п/ф (раздел про минимальные остатки п/ф).

  нужно      = остаток плана по открытым заданиям цеха на деталь
               (сколько ещё окутать) + минимальный остаток детали;
  есть       = живые партии детали на любом этапе (кроме списанных и
               отложенных в переработку) + ещё не сделанное по открытым
               заданиям участкам на первый этап детали («в работе»);
  не хватает = нужно − есть;
  произвести = не хватает, но не меньше минимальной партии.

Задание участку создаёт начальник кнопкой — предложение, не автоматика."""

from collections import defaultdict
from dataclasses import dataclass

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.dictionaries import Part, PartStage
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.services.part_units import reported_good_pieces_by_unit


@dataclass(frozen=True)
class PfDemandSource:
    """Задание цеха, из которого набралась потребность детали."""

    task_id: int
    task_name: str
    open_plan: float
    done: float
    remaining: float


@dataclass(frozen=True)
class PfDemandRow:
    part_id: int
    part_name: str
    min_stock: float | None
    min_batch: float | None
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


def compute_suggestion(
    *, task_demand: float, min_stock: float | None, stock: float, in_work: float, min_batch: float | None
) -> tuple[float, float, float]:
    """(нужно, не хватает, произвести)."""
    need = task_demand + (min_stock or 0.0)
    shortage = max(0.0, need - stock - in_work)
    suggested = max(shortage, min_batch or 0.0) if shortage > 0 else 0.0
    return need, shortage, suggested


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


def _task_demand_by_part(db: Session, task_ids: list[int] | None = None) -> dict[int, list[PfDemandSource]]:
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
    if task_ids:
        query = query.filter(ProductionTaskLine.task_id.in_(task_ids))
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


def _in_work_by_first_stage(db: Session, first_stage_ids: set[int]) -> dict[int, float]:
    if not first_stage_ids:
        return {}
    lines = (
        db.query(ProductionTaskLine)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTask.is_active.is_(True), ProductionTaskLine.part_stage_id.in_(first_stage_ids))
        .all()
    )
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
    in_work: dict[int, float] = defaultdict(float)
    for line in lines:
        in_work[line.part_stage_id] += max(0.0, float(line.quantity_pieces) - float(good.get(line.id, 0)))
    return in_work


def _order_demand_by_part(db: Session, task_ids: list[int] | None = None) -> dict[int, list[PfDemandSource]]:
    """Потребность в комплектующих п/ф из запущенных заказов на производство
    (единая модель, п.4): остаток заказа × состав позиции. Остаток — по
    операции, на которой компонент расходуется (годные + брак по ней уже
    списали комплектующие); операция не указана — весь заказ."""
    from app.models.items import ItemComponent
    from app.models.production_orders import ORDER_RELEASED, ProductionOrder, ProductionOrderLine

    out: dict[int, list[PfDemandSource]] = defaultdict(list)
    rows = (
        db.query(ProductionOrderLine, ProductionOrder)
        .join(ProductionOrder, ProductionOrder.id == ProductionOrderLine.order_id)
        .filter(ProductionOrder.status == ORDER_RELEASED)
        .all()
    )
    if not rows:
        return out
    parts_by_item = {p.item_id: p for p in db.query(Part).filter(Part.is_active.is_(True)) if p.stages}
    for ol, order in rows:
        for comp in db.query(ItemComponent).filter(ItemComponent.parent_item_id == ol.item_id):
            part = parts_by_item.get(comp.component_item_id)
            if part is None:
                continue
            line = None
            if comp.stage_id is not None:
                line = (
                    db.query(ProductionTaskLine)
                    .filter(ProductionTaskLine.order_line_id == ol.id, ProductionTaskLine.part_stage_id == comp.stage_id)
                    .first()
                )
            if task_ids and (line is None or line.task_id not in task_ids):
                continue
            done = 0.0
            if line is not None:
                done = float(
                    db.query(
                        func.coalesce(func.sum(ProductionTaskLineReport.good_pieces + ProductionTaskLineReport.defect_pieces), 0)
                    )
                    .filter(
                        ProductionTaskLineReport.task_line_id == line.id,
                        ProductionTaskLineReport.counts_toward_line.is_(True),
                    )
                    .scalar()
                )
            units_left = max(0.0, float(ol.quantity) - done)
            if units_left <= 0:
                continue
            per = float(comp.qty_per_unit)
            out[part.id].append(
                PfDemandSource(
                    task_id=line.task_id if line else 0,
                    task_name=f"Заказ №{order.id} «{order.name}»",
                    open_plan=round(float(ol.quantity) * per, 2),
                    done=round(done * per, 2),
                    remaining=round(units_left * per, 2),
                )
            )
    return out


def compute_pf_demand(db: Session, task_ids: list[int] | None = None) -> list[PfDemandRow]:
    """Детали с этапами, у которых задан минимальный остаток, есть
    потребность по заданиям цеха или заказам на производство, или что-то в
    работе.

    task_ids — только выбранные задания цеха: «что произвести, чтобы
    закрыть именно их». Минимальный остаток тогда не добавляется (запас —
    не про конкретное задание), остаток и «в работе» вычитаются как
    обычно; в список попадают только детали этих заданий."""
    parts = db.query(Part).filter(Part.is_active.is_(True)).all()
    parts = [p for p in parts if p.stages]
    first_stage: dict[int, PartStage] = {p.id: min(p.stages, key=lambda s: s.sequence_order) for p in parts}
    demand = _task_demand_by_part(db, task_ids)
    for part_id, sources in _order_demand_by_part(db, task_ids).items():
        demand.setdefault(part_id, []).extend(sources)
    stock = _stock_by_part(db)
    in_work = _in_work_by_first_stage(db, {s.id for s in first_stage.values()})
    rows = []
    for p in parts:
        fs = first_stage[p.id]
        sources = sorted(demand.get(p.id, []), key=lambda s: s.task_id)
        d = sum(s.remaining for s in sources)
        w = in_work.get(fs.id, 0.0)
        min_stock = float(p.min_stock_pieces) if p.min_stock_pieces is not None else None
        min_batch = float(p.min_batch_pieces) if p.min_batch_pieces is not None else None
        if task_ids:
            if d <= 0:
                continue
        elif min_stock is None and d <= 0 and w <= 0:
            continue
        s = stock.get(p.id, 0.0)
        need, shortage, suggested = compute_suggestion(
            task_demand=d, min_stock=None if task_ids else min_stock, stock=s, in_work=w, min_batch=min_batch
        )
        rows.append(
            PfDemandRow(
                part_id=p.id, part_name=p.name, min_stock=min_stock, min_batch=min_batch, task_demand=d,
                stock=s, in_work=w, need=need, shortage=shortage, suggested=suggested,
                first_stage_id=fs.id, first_stage_name=fs.name, first_stage_area=fs.area, sources=sources,
            )
        )
    return sorted(rows, key=lambda r: (-r.shortage, r.part_name))
