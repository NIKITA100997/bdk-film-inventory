"""Заказ на производство (единая модель, пункт 4).

Запуск раскладывает заказ по маршрутам позиций: одно задание («Задания
цеха») на каждый участок, строка — на каждую операцию каждой позиции
заказа. Строки без плёнки, с операцией техкарты: отчёт по ним двигает
партии, если позиция — деталь п/ф, и списывает в производство
комплектующие, которые по составу расходуются на этой операции
(consume_components_at_operation). Комплектующие обеспечиваются через
«Потребность п/ф» (заказ × состав, services/pf_demand.py)."""

from datetime import datetime, timezone

from sqlalchemy import false
from sqlalchemy.orm import Session

from app.core.constants import PART_UNIT_AUTO_WRITE_OFF_REASON_CODE
from app.models.areas import Area
from app.models.dictionaries import Part, PartStage
from app.models.items import Item, ItemComponent
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.production import ProductionTask, ProductionTaskLine
from app.models.production_orders import ORDER_CLOSED, ORDER_DRAFT, ORDER_RELEASED, ProductionOrder
from app.services.components import live_item_names
from app.services.part_units import mint_part_unit, write_off_part_unit
from app.services.materials import KIND_MATERIAL
from app.services.materials import consume as consume_material
from app.services.pf_demand import check_foreign_reserve


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


def attach_tasks_to_order(
    db: Session, tasks: list[ProductionTask], *, name: str, user_id: int, order_id: int | None = None,
    ship_date=None, kind: str = "customer",
) -> ProductionOrder:
    """Любое задание цеха — внутри заказа на производство (как в ERP: заказ
    → этапы на участки). order_id — добавить к запущенному заказу; без него
    — новый заказ под это задание: без строк позиций (работу задают строки
    самих заданий — плёнка, операции), сразу запущенный. Без commit."""
    if order_id is not None:
        order = db.get(ProductionOrder, order_id)
        if order is None:
            raise OrderError("Заказ не найден")
        if order.status != ORDER_RELEASED:
            raise OrderError("Добавить задание можно только в запущенный заказ")
    else:
        if ship_date is None:
            raise OrderError("Укажите срок — дату, к которой нужно сделать (от неё считаются сроки операций)")
        order = ProductionOrder(
            name=(" ".join(name.split()) or "Заказ")[:255], status=ORDER_RELEASED,
            released_at=datetime.now(timezone.utc), created_by=user_id, ship_date=ship_date, kind=kind,
        )
        db.add(order)
        db.flush()
    for task in tasks:
        task.production_order_id = order.id
    db.flush()
    # Сроки нового задания — в плане сразу (п/ф щитовых и работы участка).
    from app.services.planning import schedule_order

    schedule_order(db, order, user_id)
    return order


def sync_task_order(db: Session, order_id: int | None) -> None:
    """Заказ без строк позиций живёт своими заданиями: все в архиве — заказ
    закрыт, есть активное — запущен, заданий не осталось — заказ удаляется.
    Заказы с позициями ведут себя как раньше (закрывает начальник)."""
    if order_id is None:
        return
    db.flush()
    order = db.get(ProductionOrder, order_id)
    if order is None or order.lines:
        return
    tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id == order_id).all()
    if not tasks:
        db.delete(order)
    elif any(t.is_active for t in tasks):
        order.status = ORDER_RELEASED
    else:
        order.status = ORDER_CLOSED
    db.flush()


COMPLETE_NOTE = "Закрыто: сделано полностью, без отчёта (плёнка списывается метражом)"


def complete_tasks(db: Session, tasks: list[ProductionTask], user_id: int) -> int:
    """«Закрыть: всё сделано» — там, где по заданию не отчитываются
    (Фабрика: плёнку списывают метражом): остаток плана каждой строки
    засчитывается служебным отчётом без рулона — плёнку и партии п/ф он не
    трогает, — строки закрываются, задания уходят в архив. Без commit.
    Возвращает, сколько строк досчитано."""
    from sqlalchemy import func

    from app.models.production import ProductionTaskLineReport

    completed = 0
    for task in tasks:
        for line in task.lines:
            done = float(
                db.query(func.coalesce(func.sum(ProductionTaskLineReport.good_pieces + ProductionTaskLineReport.defect_pieces), 0))
                .filter(ProductionTaskLineReport.task_line_id == line.id, ProductionTaskLineReport.counts_toward_line.is_(True))
                .scalar()
            )
            left = round(float(line.quantity_pieces) - done, 2)
            if left > 0:
                db.add(
                    ProductionTaskLineReport(
                        task_line_id=line.id, good_pieces=left, defect_pieces=0, material_unit_id=None,
                        counts_toward_line=True, note=COMPLETE_NOTE, reported_by=user_id,
                    )
                )
                completed += 1
            line.production_closed = True
            line.is_closed = True
        task.is_active = False
    db.flush()
    return completed


def close_order(db: Session, order: ProductionOrder) -> None:
    if order.status != ORDER_RELEASED:
        raise OrderError("Закрыть можно только запущенный заказ")
    order.status = ORDER_CLOSED
    for task in db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id):
        task.is_active = False
    db.flush()


def _final_stage(part: Part) -> PartStage | None:
    return max(part.stages, key=lambda s: s.sequence_order) if part.stages else None


def detail_targets(db: Session, part: Part, from_defect: bool = False) -> list[tuple[Part, PartStage, float]]:
    """В какие детали по составу идёт деталь-комплектующее (заготовка до
    фрезеровки → детали с пазом): (деталь, операция расхода, норма на 1 шт).
    from_defect — из брака этой детали (строки состава «только брак»):
    операция не указана — первая операция детали."""
    if part.item_id is None:
        return []
    q = db.query(ItemComponent).filter(ItemComponent.component_item_id == part.item_id, ItemComponent.from_defect.is_(from_defect))
    if not from_defect:
        q = q.filter(ItemComponent.stage_id.isnot(None))
    out = []
    for comp in q:
        target = db.query(Part).filter(Part.item_id == comp.parent_item_id, Part.is_active.is_(True)).first()
        if target is None:
            continue
        stage = db.get(PartStage, comp.stage_id) if comp.stage_id else None
        if stage is None and from_defect and target.stages:
            stage = min(target.stages, key=lambda s: s.sequence_order)
        if stage is not None:
            out.append((target, stage, float(comp.qty_per_unit)))
    return sorted(out, key=lambda x: x[0].name)


def recycle_to_detail(
    db: Session, *, source_part_id: int, area: str, target_part_id: int, quantity_pieces: float, user_id: int,
    note: str | None = None,
) -> PartUnit:
    """«Переработать в деталь» по составу: брак детали (В_переработку, на
    участке area, FIFO) — в деталь, у которой в составе он отмечен «только
    брак» (36х100 из брака 36х108). Партия детали рождается на операции,
    где брак расходуется, брак списывается по норме состава событием
    «Переработка». Без commit."""
    from app.models.part_units import PartEventType
    from app.services.part_units import _split_or_reuse, record_part_event

    if quantity_pieces <= 0:
        raise ValueError("Укажите количество деталей")
    source = db.get(Part, source_part_id)
    if source is None:
        raise ValueError("Деталь-источник не найдена")
    target = next(((t, s, q) for t, s, q in detail_targets(db, source, from_defect=True) if t.id == target_part_id), None)
    if target is None:
        raise ValueError(f"По составу брак «{source.name}» не идёт в выбранную деталь")
    part, stage, per_unit = target
    if not stage.area:
        raise ValueError(f"У операции «{stage.name}» детали «{part.name}» не указан участок")
    need = round(per_unit * quantity_pieces, 4)
    candidates = (
        db.query(PartUnit)
        .filter(PartUnit.part_id == source.id, PartUnit.area == area, PartUnit.status == PartUnitStatus.V_PERERABOTKU)
        .order_by(PartUnit.manufactured_at.asc(), PartUnit.id.asc())
        .all()
    )
    available = sum(float(c.quantity_pieces) for c in candidates)
    if available + 1e-9 < need:
        raise ValueError(f"В переработке «{source.name}» {available:g} шт, а на {quantity_pieces:g} шт «{part.name}» нужно {need:g}")
    new_unit = mint_part_unit(
        db, part=part, quantity_pieces=quantity_pieces, user_id=user_id, stage_id=stage.id,
        note=(note or f"Из брака «{source.name}»")[:255],
    )
    db.flush()
    remaining = need
    labels = []
    for c in candidates:
        if remaining <= 1e-9:
            break
        take = min(remaining, float(c.quantity_pieces))
        piece = _split_or_reuse(db, c, take)
        piece.status = PartUnitStatus.SPISAN
        record_part_event(
            db, unit=piece, event_type=PartEventType.PERERABOTKA, user_id=user_id, quantity_delta=-take,
            related_part_unit_id=new_unit.id, note=note,
        )
        labels.append(f"№{piece.id} ({take:g} шт)")
        remaining -= take
    record_part_event(
        db, unit=new_unit, event_type=PartEventType.PERERABOTKA, user_id=user_id, quantity_delta=quantity_pieces,
        to_stage_id=stage.id, note=f"Из брака: {', '.join(labels)}"[:255],
    )
    db.flush()
    return new_unit


def make_detail_from_unit(
    db: Session, *, unit: PartUnit, target_part_id: int, quantity_pieces: float, user_id: int,
    occurred_at: datetime | None = None,
) -> PartUnit:
    """«Сделать деталь из заготовки» без задания (как «Перевести дальше»):
    операция детали, на которой по составу расходуется эта заготовка, —
    выполнена. Заготовка списывается в производство (норма × штук), партия
    детали рождается на этой операции, на её участке (у МК: отфрезерована и
    лежит на участке п/ф; на окутку — «Перевести на следующий этап», как
    остальные партии). Без commit."""
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
    # Без задания — зарезервированное под задания цеха не трогаем.
    check_foreign_reserve(db, part_id=unit.part_id, quantity=need, task_id=None)
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
    return new_unit


def consume_components_at_operation(
    db: Session, *, stage: PartStage, area: str, quantity: float, user_id: int, note: str | None = None,
    task_id: int | None = None, task_line_id: int | None = None,
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
    # Компонент без операции — на первой операции позиции (как и в
    # «Потребности п/ф», services/pf_demand.py).
    first = min(stage.item.stages, key=lambda s: s.sequence_order) if stage.item and stage.item.stages else stage
    comps = (
        db.query(ItemComponent)
        .filter(
            ItemComponent.parent_item_id == stage.item_id,
            (ItemComponent.stage_id == stage.id)
            | (ItemComponent.stage_id.is_(None) if first.id == stage.id else false()),
        )
        .order_by(ItemComponent.sort_order, ItemComponent.id)
        .all()
    )
    # Группы «или» (alt_group) — берётся по порядку, можно добрать из
    # нескольких вариантов; строка без группы — сама себе группа.
    groups: list[list[ItemComponent]] = []
    by_alt: dict[int, list[ItemComponent]] = {}
    for comp in comps:
        if comp.alt_group is None:
            groups.append([comp])
        elif comp.alt_group in by_alt:
            by_alt[comp.alt_group].append(comp)
        else:
            by_alt[comp.alt_group] = [comp]
            groups.append(by_alt[comp.alt_group])
    for group in groups:
        first_item = db.get(Item, group[0].component_item_id)
        if len(group) == 1 and first_item is not None and first_item.kind.code == KIND_MATERIAL:
            # Материал — без партий: расход пишется всегда, в минус тоже.
            consume_material(
                db, item=first_item, qty=round(float(group[0].qty_per_unit) * quantity, 4), user_id=user_id,
                task_line_id=task_line_id, note=note or f"В производство: {stage.name}",
            )
            continue
        # Варианты группы: (строка состава, деталь, партии FIFO, «откуда»).
        options = []
        for comp in group:
            part = db.query(Part).filter(Part.item_id == comp.component_item_id).first()
            if part is None:
                continue
            if comp.from_defect:
                units = (
                    db.query(PartUnit)
                    .filter(PartUnit.part_id == part.id, PartUnit.status == PartUnitStatus.V_PERERABOTKU)
                    .order_by(PartUnit.manufactured_at.asc(), PartUnit.id.asc())
                    .all()
                )
                options.append((comp, part, units, "брака в переработке"))
                continue
            if db.query(PartUnit.id).filter(PartUnit.part_id == part.id).first() is None:
                continue  # партии по детали не ведутся
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
            options.append((comp, part, units, "готовых" if anywhere else "готовых на участке"))
        if not options:
            continue  # ни по одному варианту партии не ведутся
        # Сколько штук позиции покрывает каждый вариант; не хватает всего —
        # отчёт не принимается, ничего не списано (решение 24.09).
        left = quantity
        plan: list[tuple] = []
        for comp, part, units, where in options:
            if left <= 1e-9:
                break
            per = float(comp.qty_per_unit)
            available = sum(float(u.quantity_pieces) for u in units)
            covers = min(left, available / per) if per > 0 else left
            if covers > 1e-9:
                plan.append((comp, part, units, round(covers * per, 4)))
                left -= covers
        if left > 1e-6:
            variants = "; ".join(
                f"«{part.name}»{' (брак)' if comp.from_defect else ''}: {where} {sum(float(u.quantity_pieces) for u in units):g} шт"
                for comp, part, units, where in options
            )
            need_first = round(float(options[0][0].qty_per_unit) * quantity, 4)
            raise ValueError(
                f"Не хватает для операции «{stage.name}» (нужно {need_first:g} шт"
                f"{' по основному варианту' if len(options) > 1 else ''}) — есть {variants}"
            )
        for comp, part, units, need in plan:
            if not comp.from_defect:
                # Резерв этой детали под другие задания цеха не расходуется.
                check_foreign_reserve(db, part_id=part.id, quantity=need, task_id=task_id)
            remaining = need
            for unit in units:
                if remaining <= 1e-9:
                    break
                take = min(remaining, float(unit.quantity_pieces))
                write_off_part_unit(
                    db, unit=unit, quantity_pieces=take, reason=PART_UNIT_AUTO_WRITE_OFF_REASON_CODE, user_id=user_id,
                    note=note or (f"Из брака в производство: {stage.name}" if comp.from_defect else f"В производство: {stage.name}"),
                )
                written.append((unit, take))
                remaining -= take
        db.flush()
    return written
