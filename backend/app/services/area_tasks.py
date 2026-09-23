"""Задания участкам — п/ф-сторона отчёта (раздел про задания участкам).

Отчёт по строке, привязанной к этапу детали п/ф, двигает партии этой детали
на участке задания:
  • первый этап детали — работа рождает партию: хорошие штуки минтятся на
    этом этапе и сразу переводятся на следующий (если он есть);
  • средний этап — хорошие штуки партий, лежащих на этом этапе и участке,
    переводятся дальше по FIFO (от самой старой по дате изготовления);
  • брак на среднем этапе списывается с тех же партий; на первом этапе брак
    только считается — такие штуки в учёт п/ф ещё не попадали.
Последний (не первый) этап детали в задание участку не берётся — там деталь
уже готова и расходуется заданием следующего передела.

Кандидаты ищутся строго по этапу, не только по участку: у детали коробки
Склейка МДФ и Фрезеровка стоят на одном участке подряд, и без условия по
этапу брак мог бы списаться с только что переведённой дальше партии."""

from datetime import datetime

from sqlalchemy.orm import Session

from app.models.dictionaries import PartStage
from app.models.part_units import PartUnit, PartUnitStatus
from app.services.part_units import (
    advance_part_unit,
    mint_part_unit,
    reported_good_pieces_by_unit,
    write_off_part_unit,
)


def _ordered_stages(stage: PartStage) -> list[PartStage]:
    return sorted(stage.part.stages, key=lambda s: s.sequence_order)


def validate_line_stage(db: Session, *, task_area: str, part_stage_id: int) -> PartStage:
    stage = db.get(PartStage, part_stage_id)
    if stage is None:
        raise ValueError("Этап детали не найден")
    if stage.area != task_area:
        raise ValueError(f"Этап «{stage.name}» детали «{stage.part.name}» выполняется на другом участке")
    stages = _ordered_stages(stage)
    if len(stages) > 1 and stage.id == stages[-1].id:
        raise ValueError(
            f"«{stage.name}» — последний этап детали «{stage.part.name}»: там она уже готова, "
            "в задание участку берутся этапы, на которых деталь делается"
        )
    return stage


def _units_at_stage(db: Session, stage: PartStage, area: str) -> list[tuple[PartUnit, float]]:
    candidates = (
        db.query(PartUnit)
        .filter(
            PartUnit.part_id == stage.part_id,
            PartUnit.stage_id == stage.id,
            PartUnit.area == area,
            PartUnit.status == PartUnitStatus.VYDAN_UCHASTKU,
        )
        .order_by(PartUnit.manufactured_at.asc(), PartUnit.id.asc())
        .all()
    )
    reported = reported_good_pieces_by_unit(db, [c.id for c in candidates])
    return [(c, float(c.quantity_pieces) - reported.get(c.id, 0.0)) for c in candidates]


def _take_fifo(db: Session, stage: PartStage, area: str, quantity: float, what: str) -> list[tuple[PartUnit, float]]:
    units = [(u, free) for u, free in _units_at_stage(db, stage, area) if free > 0]
    available = sum(free for _, free in units)
    if available + 1e-9 < quantity:
        raise ValueError(
            f"Не хватает партий «{stage.part.name}» на этапе «{stage.name}» для {what}: "
            f"на участке {available:g} шт, нужно {quantity:g} шт"
        )
    taken: list[tuple[PartUnit, float]] = []
    remaining = quantity
    for unit, free in units:
        if remaining <= 0:
            break
        take = min(remaining, free)
        taken.append((unit, take))
        remaining -= take
    return taken


def apply_report_to_part_units(
    db: Session,
    *,
    stage: PartStage,
    area: str,
    good_pieces: float,
    defect_pieces: float,
    defect_reason: str | None,
    note: str | None,
    user_id: int,
    occurred_at: datetime,
) -> None:
    """Одна транзакция вызывающего кода; сессия с autoflush=False, поэтому
    flush после каждой фазы — иначе брак не увидел бы, что хорошие уже ушли."""
    stages = _ordered_stages(stage)
    idx = next(i for i, s in enumerate(stages) if s.id == stage.id)
    is_first = idx == 0
    has_next = idx + 1 < len(stages)

    if good_pieces > 0:
        if is_first:
            unit = mint_part_unit(
                db, part=stage.part, quantity_pieces=good_pieces, user_id=user_id,
                stage_id=stage.id, manufactured_at=occurred_at.date(), note=note,
            )
            db.flush()
            if has_next:
                advance_part_unit(db, unit=unit, quantity_pieces=good_pieces, user_id=user_id, occurred_at=occurred_at)
        else:
            for unit, take in _take_fifo(db, stage, area, good_pieces, "хороших"):
                advance_part_unit(db, unit=unit, quantity_pieces=take, user_id=user_id, occurred_at=occurred_at)
        db.flush()

    if defect_pieces > 0 and not is_first:
        for unit, take in _take_fifo(db, stage, area, defect_pieces, "брака"):
            write_off_part_unit(
                db, unit=unit, quantity_pieces=take, reason=defect_reason, user_id=user_id,
                note=note, occurred_at=occurred_at,
            )
        db.flush()
