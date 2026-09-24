"""Маршрут позиции (раздел про техкарты, этап 2 единой модели) — список
операций по участкам. У каждой детали свой (решение 24.09), массовая смена
— тот же маршрут, применённый к нескольким деталям одной транзакцией.

Этапы правятся НА МЕСТЕ, а не стираются и создаются заново: на этап
ссылаются партии п/ф, их события и строки-операции заданий. Этап из нового
списка сопоставляется со старым по коду, потом по названию, потом по
позиции в списке (сменили участок у строки — тот же этап) — у него
остаётся тот же id, меняются только порядок/название, поэтому
партии и история остаются на своём этапе. Лишний этап удаляется, только
если на него ничего не ссылается; иначе — понятная ошибка, ничего не
меняется."""

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.dictionaries import Part, PartStage
from app.models.items import Item
from app.models.part_units import PartUnit, PartUnitEvent
from app.models.production import ProductionTaskLine


@dataclass
class RouteStep:
    code: str
    name: str
    area: str | None


class RouteInUseError(ValueError):
    pass


def _stage_in_use(db: Session, stage_id: int) -> bool:
    return (
        db.query(PartUnit.id).filter(PartUnit.stage_id == stage_id).first() is not None
        or db.query(PartUnitEvent.id)
        .filter((PartUnitEvent.from_stage_id == stage_id) | (PartUnitEvent.to_stage_id == stage_id))
        .first()
        is not None
        or db.query(ProductionTaskLine.id).filter(ProductionTaskLine.part_stage_id == stage_id).first() is not None
    )


def apply_route(db: Session, part: Part | Item, steps: list[RouteStep]) -> None:
    """Привести маршрут детали — или любой позиции номенклатуры (пункт 3
    единой модели) — к списку steps (без commit). Для позиции, за которой
    стоит деталь п/ф, вызывайте с деталью: новые этапы получат и деталь, и
    позицию."""
    # Код этапа — String(50), а экран кладёт туда код участка (до 128).
    steps = [RouteStep(code=s.code[:50], name=s.name[:255], area=s.area) for s in steps]
    existing = sorted(part.stages, key=lambda s: s.sequence_order)
    pool = list(existing)
    matched: list[PartStage | None] = [None] * len(steps)
    # Сопоставление: по коду, потом по названию, потом по позиции в списке
    # (сменили участок у строки — это тот же этап, а не удаление + новый).
    for key in (lambda s: s.code, lambda s: s.name):
        for i, step in enumerate(steps):
            if matched[i] is None:
                hit = next((s for s in pool if key(s) == key(step)), None)
                if hit is not None:
                    pool.remove(hit)
                    matched[i] = hit
    for i in range(len(steps)):
        if matched[i] is None and i < len(existing) and existing[i] in pool:
            pool.remove(existing[i])
            matched[i] = existing[i]

    for stage in pool:
        if _stage_in_use(db, stage.id):
            raise RouteInUseError(
                f"«{part.name}»: этап «{stage.name}» нельзя убрать — на нём есть партии или история. "
                "Можно поменять ему участок или порядок, но не удалять."
            )

    for stage in pool:
        part.stages.remove(stage)
        db.delete(stage)
    # Уникальность (part_id, sequence_order): сначала уводим оставшиеся
    # этапы на временные отрицательные номера, потом ставим итоговые.
    for i, stage in enumerate(s for s in matched if s is not None):
        stage.sequence_order = -(i + 1)
    db.flush()
    for i, (step, stage) in enumerate(zip(steps, matched), start=1):
        if stage is None:
            part.stages.append(PartStage(sequence_order=i, code=step.code, name=step.name, area=step.area))
            # у позиции без детали item_id ставит сама коллекция Item.stages
        else:
            stage.sequence_order = i
            stage.code = step.code
            stage.name = step.name
            stage.area = step.area
    db.flush()
