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

from app.models.area_tasks import AreaTask, AreaTaskLine, AreaTaskReport
from app.models.dictionaries import Part, PartStage
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.services.part_units import reported_good_pieces_by_unit


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


def compute_suggestion(
    *, task_demand: float, min_stock: float | None, stock: float, in_work: float, min_batch: float | None
) -> tuple[float, float, float]:
    """(нужно, не хватает, произвести)."""
    need = task_demand + (min_stock or 0.0)
    shortage = max(0.0, need - stock - in_work)
    suggested = max(shortage, min_batch or 0.0) if shortage > 0 else 0.0
    return need, shortage, suggested


def _task_demand_by_part_name(db: Session) -> dict[str, float]:
    lines = (
        db.query(ProductionTaskLine)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(
            ProductionTask.is_active.is_(True),
            ProductionTaskLine.production_closed.is_(False),
            ProductionTaskLine.part_name.isnot(None),
        )
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
    demand: dict[str, float] = defaultdict(float)
    for line in lines:
        demand[line.part_name] += max(0.0, float(line.quantity_pieces) - float(good.get(line.id, 0)))
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
        db.query(AreaTaskLine)
        .join(AreaTask, AreaTask.id == AreaTaskLine.task_id)
        .filter(AreaTask.is_active.is_(True), AreaTaskLine.part_stage_id.in_(first_stage_ids))
        .all()
    )
    if not lines:
        return {}
    good = dict(
        db.query(AreaTaskReport.line_id, func.coalesce(func.sum(AreaTaskReport.good_pieces), 0))
        .filter(AreaTaskReport.line_id.in_([line.id for line in lines]))
        .group_by(AreaTaskReport.line_id)
        .all()
    )
    in_work: dict[int, float] = defaultdict(float)
    for line in lines:
        in_work[line.part_stage_id] += max(0.0, float(line.quantity_pieces) - float(good.get(line.id, 0)))
    return in_work


def compute_pf_demand(db: Session) -> list[PfDemandRow]:
    """Детали с этапами, у которых задан минимальный остаток, есть
    потребность по заданиям цеха или что-то в работе."""
    parts = db.query(Part).filter(Part.is_active.is_(True)).all()
    parts = [p for p in parts if p.stages]
    first_stage: dict[int, PartStage] = {p.id: min(p.stages, key=lambda s: s.sequence_order) for p in parts}
    demand = _task_demand_by_part_name(db)
    stock = _stock_by_part(db)
    in_work = _in_work_by_first_stage(db, {s.id for s in first_stage.values()})
    rows = []
    for p in parts:
        fs = first_stage[p.id]
        d = demand.get(p.name, 0.0)
        w = in_work.get(fs.id, 0.0)
        min_stock = float(p.min_stock_pieces) if p.min_stock_pieces is not None else None
        min_batch = float(p.min_batch_pieces) if p.min_batch_pieces is not None else None
        if min_stock is None and d <= 0 and w <= 0:
            continue
        s = stock.get(p.id, 0.0)
        need, shortage, suggested = compute_suggestion(
            task_demand=d, min_stock=min_stock, stock=s, in_work=w, min_batch=min_batch
        )
        rows.append(
            PfDemandRow(
                part_id=p.id, part_name=p.name, min_stock=min_stock, min_batch=min_batch, task_demand=d,
                stock=s, in_work=w, need=need, shortage=shortage, suggested=suggested,
                first_stage_id=fs.id, first_stage_name=fs.name, first_stage_area=fs.area,
            )
        )
    return sorted(rows, key=lambda r: (-r.shortage, r.part_name))
