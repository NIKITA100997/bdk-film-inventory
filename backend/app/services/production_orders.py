"""Заказ на производство (единая модель, пункт 4).

Запуск раскладывает заказ по маршрутам позиций: одно задание («Задания
цеха») на каждый участок, строка — на каждую операцию каждой позиции
заказа. Строки без плёнки, с операцией техкарты: отчёт по ним двигает
партии, если позиция — деталь п/ф, и списывает в производство
комплектующие, которые по составу расходуются на этой операции
(consume_components_at_operation). Комплектующие обеспечиваются через
«Потребность п/ф» (заказ × состав, services/pf_demand.py)."""

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.core.constants import PART_UNIT_AUTO_WRITE_OFF_REASON_CODE
from app.models.areas import Area
from app.models.dictionaries import Part, PartStage
from app.models.items import Item, ItemComponent
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.production import ProductionTask, ProductionTaskLine
from app.models.production_orders import ORDER_CLOSED, ORDER_DRAFT, ORDER_RELEASED, ProductionOrder
from app.services.components import live_item_names
from app.services.part_units import advance_part_unit, mint_part_unit, write_off_part_unit


class OrderError(ValueError):
    pass


def release_order(db: Session, order: ProductionOrder, user_id: int) -> list[ProductionTask]:
    """Запустить заказ: задания участкам по маршрутам позиций (без commit).
    Позиция без маршрута — ошибка, заказ не запускается целиком."""
    if order.status != ORDER_DRAFT:
        raise OrderError("Запустить можно только черновик заказа")
    if not order.lines:
        raise OrderError("В заказе нет строк")
    names = live_item_names(db, {ln.item_id for ln in order.lines})
    no_route = [names.get(ln.item_id, f"#{ln.item_id}") for ln in order.lines if not db.get(Item, ln.item_id).stages]
    if no_route:
        raise OrderError("Нет маршрута у позиций: " + ", ".join(no_route) + " — задайте его в техкарте")
    area_names = {a.code: a.name for a in db.query(Area)}
    tasks: dict[str, ProductionTask] = {}
    for ln in order.lines:
        item = db.get(Item, ln.item_id)
        part = db.query(Part).filter(Part.item_id == item.id).first()
        stages = sorted(item.stages, key=lambda s: s.sequence_order)
        # У детали п/ф последний этап — не операция, а готовая деталь на
        # хранении (как и в задании без плёнки): его в задание не берём.
        if part is not None and len(stages) > 1:
            stages = stages[:-1]
        for stage in stages:
            if not stage.area:
                raise OrderError(f"«{names.get(item.id)}»: у операции «{stage.name}» не задан участок")
            task = tasks.get(stage.area)
            if task is None:
                task = ProductionTask(
                    name=f"Заказ №{order.id} «{order.name}» — {area_names.get(stage.area, stage.area)}",
                    area=stage.area, created_by=user_id, production_order_id=order.id, is_active=True,
                )
                db.add(task)
                tasks[stage.area] = task
            task.lines.append(
                ProductionTaskLine(
                    quantity_pieces=ln.quantity, part_stage_id=stage.id, part_id=part.id if part else None,
                    part_name=names.get(item.id, item.name), width_mm=float(part.width_mm) if part else 0, length_m=0,
                    order_line_id=ln.id,
                )
            )
    order.status = ORDER_RELEASED
    order.released_at = datetime.now(timezone.utc)
    db.flush()
    return list(tasks.values())


def close_order(db: Session, order: ProductionOrder) -> None:
    if order.status != ORDER_RELEASED:
        raise OrderError("Закрыть можно только запущенный заказ")
    order.status = ORDER_CLOSED
    for task in db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id):
        task.is_active = False
    db.flush()


def _final_stage(part: Part) -> PartStage | None:
    return max(part.stages, key=lambda s: s.sequence_order) if part.stages else None


def detail_targets(db: Session, part: Part) -> list[tuple[Part, PartStage, float]]:
    """В какие детали по составу идёт деталь-комплектующее (заготовка до
    фрезеровки → детали с пазом): (деталь, операция расхода, норма на 1 шт)."""
    if part.item_id is None:
        return []
    out = []
    for comp in db.query(ItemComponent).filter(
        ItemComponent.component_item_id == part.item_id, ItemComponent.stage_id.isnot(None)
    ):
        target = db.query(Part).filter(Part.item_id == comp.parent_item_id, Part.is_active.is_(True)).first()
        stage = db.get(PartStage, comp.stage_id)
        if target is not None and stage is not None:
            out.append((target, stage, float(comp.qty_per_unit)))
    return sorted(out, key=lambda x: x[0].name)


def make_detail_from_unit(
    db: Session, *, unit: PartUnit, target_part_id: int, quantity_pieces: float, user_id: int,
    occurred_at: datetime | None = None,
) -> PartUnit:
    """«Сделать деталь из заготовки» без задания (как «Перевести дальше»):
    операция детали, на которой по составу расходуется эта заготовка, —
    выполнена. Заготовка списывается в производство (норма × штук), партия
    детали рождается на этой операции и сразу переходит на следующую
    (у МК: фрезеровка сделана → «Окутка»). Без commit."""
    if quantity_pieces <= 0:
        raise ValueError("Укажите количество деталей")
    target = next(((t, s, q) for t, s, q in detail_targets(db, unit.part) if t.id == target_part_id), None)
    if target is None:
        raise ValueError(f"«{unit.part.name}» по составу не идёт в выбранную деталь")
    part, stage, per_unit = target
    final = _final_stage(unit.part)
    if final is not None and unit.stage_id != final.id:
        raise ValueError(f"Партия ещё не готова: она на этапе «{unit.stage.name}», а нужна на «{final.name}»")
    if unit.status not in (PartUnitStatus.VYDAN_UCHASTKU, PartUnitStatus.NA_KHRANENII):
        raise ValueError("Из этой партии сейчас ничего не сделать — она не на участке и не на хранении")
    if not stage.area:
        raise ValueError(f"У операции «{stage.name}» детали «{part.name}» не указан участок")
    need = round(per_unit * quantity_pieces, 4)
    if need > float(unit.quantity_pieces) + 1e-9:
        raise ValueError(f"В партии №{unit.id} {float(unit.quantity_pieces):g} шт, а на {quantity_pieces:g} шт детали нужно {need:g}")
    when = occurred_at or datetime.now(timezone.utc)
    write_off_part_unit(
        db, unit=unit, quantity_pieces=need, reason=PART_UNIT_AUTO_WRITE_OFF_REASON_CODE, user_id=user_id,
        note=f"В производство: {part.name} — {stage.name}"[:255], occurred_at=when,
    )
    new_unit = mint_part_unit(
        db, part=part, quantity_pieces=quantity_pieces, user_id=user_id, stage_id=stage.id,
        manufactured_at=when.date(), note=f"Из партии №{unit.id} «{unit.part.name}»"[:255],
    )
    db.flush()
    moved, _ = advance_part_unit(db, unit=new_unit, quantity_pieces=quantity_pieces, user_id=user_id, occurred_at=when)
    db.flush()
    return moved


def consume_components_at_operation(
    db: Session, *, stage: PartStage, area: str, quantity: float, user_id: int, note: str | None = None
) -> list[tuple[PartUnit, float]]:
    """Списать в производство комплектующие п/ф, которые по составу позиции
    расходуются на этой операции: состав × quantity, FIFO по дате
    изготовления, из готовых партий (последний этап детали) на участке
    операции. Не хватает — ValueError, ничего не списано (решение 24.09:
    отчёт не принимается). Деталь, по которой партии вообще не ведутся, —
    не списывается (учёт по ней не ведут)."""
    if quantity <= 0:
        return []
    written: list[tuple[PartUnit, float]] = []
    comps = (
        db.query(ItemComponent)
        .filter(ItemComponent.parent_item_id == stage.item_id, ItemComponent.stage_id == stage.id)
        .order_by(ItemComponent.sort_order, ItemComponent.id)
        .all()
    )
    for comp in comps:
        part = db.query(Part).filter(Part.item_id == comp.component_item_id).first()
        if part is None:
            continue
        if db.query(PartUnit.id).filter(PartUnit.part_id == part.id).first() is None:
            continue  # партии по детали не ведутся
        need = round(float(comp.qty_per_unit) * quantity, 4)
        q = db.query(PartUnit).filter(
            PartUnit.part_id == part.id,
            PartUnit.status.in_([PartUnitStatus.VYDAN_UCHASTKU, PartUnitStatus.NA_KHRANENII]),
        )
        final = _final_stage(part)
        if final is not None:
            q = q.filter(PartUnit.stage_id == final.id)
        # Последний этап без участка («Готово» — общий запас: заготовка МДФ
        # щитовой панели идёт дальше то на ламинацию, то на фрезеровку) —
        # партии берутся с любого участка; иначе — только с участка операции.
        anywhere = final is not None and final.area is None
        if not anywhere:
            q = q.filter(PartUnit.area == area)
        units = q.order_by(PartUnit.manufactured_at.asc(), PartUnit.id.asc()).all()
        available = sum(float(u.quantity_pieces) for u in units)
        if available + 1e-9 < need:
            raise ValueError(
                f"Не хватает «{part.name}» для операции «{stage.name}»: {'' if anywhere else 'на участке '}готовых {available:g} шт, "
                f"нужно {need:g} шт"
            )
        remaining = need
        for unit in units:
            if remaining <= 1e-9:
                break
            take = min(remaining, float(unit.quantity_pieces))
            write_off_part_unit(
                db, unit=unit, quantity_pieces=take, reason=PART_UNIT_AUTO_WRITE_OFF_REASON_CODE, user_id=user_id,
                note=note or f"В производство: {stage.name}",
            )
            written.append((unit, take))
            remaining -= take
        db.flush()
    return written
