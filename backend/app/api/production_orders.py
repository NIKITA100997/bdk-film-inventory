"""Заказы на производство (единая модель, пункт 4): что и сколько сделать —
позиции номенклатуры любого вида; запуск раскладывает заказ по маршрутам
позиций на задания участкам, прогресс — по отчётам этих заданий."""

from collections import defaultdict
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import PartStage
from app.models.items import Item, ItemComponent, ItemKind
from app.models.production import PlanSlot, ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.production_orders import (
    ORDER_CLOSED,
    ORDER_DRAFT,
    ORDER_KIND_CUSTOMER,
    ORDER_KIND_STOCK,
    ProductionOrder,
    ProductionOrderLine,
)
from app.models.users import User
from app.services.components import live_item_names, planned_components
from app.services.planning import PfPick, order_pf_needs, order_plan_status, release_pf, schedule_order
from app.services.production_orders import OrderError, close_order, complete_tasks, release_order
from app.services.schedule_import import import_schedule
from app.models.items import ItemType

router = APIRouter(tags=["production-orders"])

view_orders = require_permission("production_tasks.manage", "production_tasks.view", "production_tasks.report")
manage_orders = require_permission("production_tasks.manage")


class OrderLineIn(BaseModel):
    item_id: int
    quantity: float = Field(gt=0)
    note: str | None = None


class OrderIn(BaseModel):
    name: str
    ship_date: date | None = None
    note: str | None = None
    kind: str = ORDER_KIND_CUSTOMER  # customer | stock
    lines: list[OrderLineIn] = Field(min_length=1)


class OperationProgress(BaseModel):
    stage_id: int
    name: str
    area: str | None
    area_name: str | None
    task_id: int | None
    task_line_id: int | None
    good: float
    defect: float
    remaining: float


class ComponentNeed(BaseModel):
    item_id: int
    name: str
    per_unit: float
    total: float
    unit: str
    operation_name: str | None


class OrderLineOut(BaseModel):
    id: int
    item_id: int
    item_name: str
    kind_name: str
    quantity: float
    note: str | None
    done: float  # готово по последней операции маршрута
    operations: list[OperationProgress]
    components: list[ComponentNeed]


class OrderTaskOut(BaseModel):
    """Задание участку внутри заказа — для карточки заказа."""

    id: int
    name: str
    area: str
    area_name: str | None
    is_active: bool
    for_task_id: int | None
    lines_count: int
    planned: float  # шт по всем строкам
    done: float  # годных по отчётам
    with_film: bool  # есть строки с плёнкой (окутка/ламинация)
    with_parts: bool  # есть строки, расходующие детали п/ф
    plan_from: date | None = None  # первый и последний день плана задания
    plan_to: date | None = None


class OrderOut(BaseModel):
    id: int
    name: str
    ship_date: date | None
    note: str | None
    status: str
    kind: str = ORDER_KIND_CUSTOMER
    created_by_name: str
    created_at: datetime
    released_at: datetime | None
    task_ids: list[int]
    lines: list[OrderLineOut]
    tasks: list[OrderTaskOut] = []
    # План: последний день плана, не успевает к отгрузке, просрочено штук.
    plan_finish: date | None = None
    plan_late: bool = False
    plan_overdue: float = 0.0
    planned: bool = False


def _order_out(db: Session, order: ProductionOrder) -> OrderOut:
    names = live_item_names(db, {ln.item_id for ln in order.lines})
    kinds = {k.id: k for k in db.query(ItemKind)}
    area_names = {a.code: a.name for a in db.query(Area)}
    task_lines = (
        db.query(ProductionTaskLine)
        .filter(ProductionTaskLine.order_line_id.in_([ln.id for ln in order.lines]))
        .all()
        if order.lines
        else []
    )
    agg: dict[int, tuple[float, float]] = {}
    if task_lines:
        for line_id, good, defect in (
            db.query(
                ProductionTaskLineReport.task_line_id,
                func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
                func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0),
            )
            .filter(
                ProductionTaskLineReport.task_line_id.in_([t.id for t in task_lines]),
                ProductionTaskLineReport.counts_toward_line.is_(True),
            )
            .group_by(ProductionTaskLineReport.task_line_id)
        ):
            agg[line_id] = (float(good), float(defect))
    by_order_line: dict[int, dict[int, ProductionTaskLine]] = defaultdict(dict)
    for t in task_lines:
        by_order_line[t.order_line_id][t.part_stage_id] = t

    out_lines = []
    for ln in order.lines:
        item = db.get(Item, ln.item_id)
        stages = sorted(item.stages, key=lambda s: s.sequence_order)
        stage_names = {s.id: s.name for s in stages}
        ops = []
        for s in stages:
            tl = by_order_line[ln.id].get(s.id)
            good, defect = agg.get(tl.id, (0.0, 0.0)) if tl else (0.0, 0.0)
            ops.append(
                OperationProgress(
                    stage_id=s.id, name=s.name, area=s.area, area_name=area_names.get(s.area), task_id=tl.task_id if tl else None,
                    task_line_id=tl.id if tl else None, good=good, defect=defect, remaining=max(0.0, float(ln.quantity) - good),
                )
            )
        comps = planned_components(db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id).all())
        comp_names = live_item_names(db, {c.component_item_id for c in comps})
        comp_items = {i.id: i for i in db.query(Item).filter(Item.id.in_([c.component_item_id for c in comps]))} if comps else {}
        out_lines.append(
            OrderLineOut(
                id=ln.id, item_id=item.id, item_name=names.get(item.id, item.name), kind_name=kinds[item.kind_id].name,
                quantity=float(ln.quantity), note=ln.note, done=ops[-1].good if ops else 0.0, operations=ops,
                components=[
                    ComponentNeed(
                        item_id=c.component_item_id, name=comp_names.get(c.component_item_id, "—"),
                        per_unit=float(c.qty_per_unit), total=round(float(c.qty_per_unit) * float(ln.quantity), 2),
                        unit=kinds[comp_items[c.component_item_id].kind_id].unit if c.component_item_id in comp_items else "шт",
                        operation_name=stage_names.get(c.stage_id) if c.stage_id else None,
                    )
                    for c in comps
                ],
            )
        )
    author = db.get(User, order.created_by)
    tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id).order_by(ProductionTask.id).all()
    return OrderOut(
        id=order.id, name=order.name, ship_date=order.ship_date, note=order.note, status=order.status, kind=order.kind,
        created_by_name=(author.full_name or author.username) if author else "—", created_at=order.created_at,
        released_at=order.released_at, task_ids=[t.id for t in tasks], lines=out_lines,
        tasks=_tasks_out(db, tasks, area_names),
        **_plan_fields(db, order),
    )


def _plan_fields(db: Session, order: ProductionOrder) -> dict:
    ps = order_plan_status(db, order)
    return {"plan_finish": ps.finish, "plan_late": ps.late, "plan_overdue": ps.overdue, "planned": ps.planned}


def _tasks_out(db: Session, tasks: list[ProductionTask], area_names: dict[str, str]) -> list[OrderTaskOut]:
    if not tasks:
        return []
    line_ids = [ln.id for t in tasks for ln in t.lines]
    good = (
        dict(
            db.query(ProductionTaskLineReport.task_line_id, func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
            .filter(
                ProductionTaskLineReport.task_line_id.in_(line_ids),
                ProductionTaskLineReport.counts_toward_line.is_(True),
            )
            .group_by(ProductionTaskLineReport.task_line_id)
        )
        if line_ids
        else {}
    )
    slot_days: dict[int, list[date]] = defaultdict(list)
    line_task = {ln.id: t.id for t in tasks for ln in t.lines}
    if line_task:
        for s in db.query(PlanSlot).filter(PlanSlot.task_line_id.in_(list(line_task))):
            slot_days[line_task[s.task_line_id]].append(s.date)
    return [
        OrderTaskOut(
            plan_from=min(slot_days[t.id]) if slot_days.get(t.id) else None,
            plan_to=max(slot_days[t.id]) if slot_days.get(t.id) else None,
            id=t.id, name=t.name or (t.product_model.name if t.product_model else f"Задание №{t.id}"), area=t.area,
            area_name=area_names.get(t.area), is_active=t.is_active, for_task_id=t.for_task_id, lines_count=len(t.lines),
            planned=round(sum(float(ln.quantity_pieces) for ln in t.lines), 2),
            done=round(sum(min(float(good.get(ln.id, 0)), float(ln.quantity_pieces)) for ln in t.lines), 2),
            with_film=any(ln.material_id is not None for ln in t.lines),
            with_parts=any(ln.part_id is not None and ln.part_stage_id is None for ln in t.lines),
        )
        for t in tasks
    ]


def _get_order(db: Session, order_id: int) -> ProductionOrder:
    order = db.get(ProductionOrder, order_id)
    if order is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заказ не найден")
    return order


def _write_lines(db: Session, order: ProductionOrder, lines: list[OrderLineIn]) -> None:
    order.lines.clear()
    db.flush()
    for i, ln in enumerate(lines, start=1):
        item = db.get(Item, ln.item_id)
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
        if item.is_model:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, f"«{item.name}» — модель: в заказ берётся её вариант (размер, цвет…)"
            )
        order.lines.append(
            ProductionOrderLine(item_id=ln.item_id, quantity=ln.quantity, note=(ln.note or "").strip() or None, sort_order=i)
        )


@router.get("/production-orders", response_model=list[OrderOut])
def list_orders(
    include_closed: bool = Query(default=False),
    item_id: int | None = Query(default=None),
    model_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(view_orders),
) -> list[OrderOut]:
    q = db.query(ProductionOrder)
    if model_id is not None:
        # Заказы по любому варианту модели (общая история модели).
        variant_ids = [i for (i,) in db.query(Item.id).filter(Item.model_id == model_id)]
        q = q.filter(ProductionOrder.lines.any(ProductionOrderLine.item_id.in_(variant_ids or [-1])))
    if item_id is not None:
        # Заказы, где есть позиция (для вкладки «Заказы» карточки позиции).
        q = q.filter(ProductionOrder.lines.any(ProductionOrderLine.item_id == item_id))
    if not include_closed:
        q = q.filter(ProductionOrder.status != ORDER_CLOSED)
    return [_order_out(db, o) for o in q.order_by(ProductionOrder.id.desc())]


view_readiness = require_permission(
    "production_tasks.manage", "production_tasks.view", "production_tasks.report", "sales_calculator.view"
)


class ReadinessLineOut(BaseModel):
    item_name: str
    quantity: float
    done: float


class ReadinessStageOut(BaseModel):
    name: str
    seq: float  # порядок колонки
    plan: float
    done: float
    plan_date: date | None  # последний день плана этапа
    status: str  # done | progress | planned | overdue | none


class ReadinessOut(BaseModel):
    id: int
    name: str
    status: str
    ship_date: date | None
    plan_finish: date | None
    plan_late: bool
    plan_overdue: float
    planned: bool
    quantity: float
    done: float
    lines: list[ReadinessLineOut]
    stages: list[ReadinessStageOut] = []


PF_STAGE = "П/ф"


def _readiness_stages(db: Session, order: ProductionOrder) -> list[ReadinessStageOut]:
    """Этапы заказа для продажника: операции изделия (по названию, в порядке
    маршрута), п/ф — одной колонкой; у заказа из заданий — по участкам."""
    from collections import defaultdict as _dd
    from datetime import date as _date

    tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id).all()
    lines = [(ln, t) for t in tasks for ln in t.lines]
    if not lines:
        return []
    area_names = {a.code: a.name for a in db.query(Area)}
    stage_of = {
        st.id: st for st in db.query(PartStage).filter(PartStage.id.in_({ln.part_stage_id for ln, _ in lines if ln.part_stage_id}))
    }
    good = {
        lid: float(g)
        for lid, g in db.query(ProductionTaskLineReport.task_line_id, func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
        .filter(ProductionTaskLineReport.task_line_id.in_([ln.id for ln, _ in lines]), ProductionTaskLineReport.counts_toward_line.is_(True))
        .group_by(ProductionTaskLineReport.task_line_id)
    }
    last_slot: dict[int, _date] = {}
    for sl in db.query(PlanSlot).filter(PlanSlot.task_line_id.in_([ln.id for ln, _ in lines])):
        last_slot[sl.task_line_id] = max(last_slot.get(sl.task_line_id, sl.date), sl.date)
    acc: dict[str, dict] = _dd(lambda: {"seq": 0.0, "plan": 0.0, "done": 0.0, "date": None, "overdue": False})
    today = _date.today()
    for ln, t in lines:
        st = stage_of.get(ln.part_stage_id) if ln.part_stage_id else None
        if st is not None and st.part_id is not None:
            key, seq = PF_STAGE, -1.0  # п/ф — перед операциями изделия
        elif st is not None:
            key, seq = st.name, float(st.sequence_order)
        else:
            key, seq = area_names.get(t.area, t.area), 100.0
        a = acc[key]
        a["seq"] = seq
        plan = float(ln.quantity_pieces)
        done = min(good.get(ln.id, 0.0), plan)
        a["plan"] += plan
        a["done"] += done
        d = last_slot.get(ln.id)
        if d is not None:
            a["date"] = max(a["date"], d) if a["date"] else d
            if d < today and done < plan:
                a["overdue"] = True
    out = []
    for name, a in acc.items():
        if a["plan"] > 0 and a["done"] >= a["plan"]:
            st_ = "done"
        elif a["overdue"]:
            st_ = "overdue"
        elif a["done"] > 0:
            st_ = "progress"
        elif a["date"]:
            st_ = "planned"
        else:
            st_ = "none"
        out.append(
            ReadinessStageOut(
                name=name, seq=a["seq"], plan=round(a["plan"], 2), done=round(a["done"], 2), plan_date=a["date"], status=st_
            )
        )
    return sorted(out, key=lambda x: (x.seq, x.name))


@router.get("/production-orders/readiness", response_model=list[ReadinessOut])
def orders_readiness(
    include_closed: bool = False, db: Session = Depends(get_db), user: User = Depends(view_readiness)
) -> list[ReadinessOut]:
    """Готовность заказов для продажника: когда будет готово по плану,
    успевает ли к отгрузке, сколько сделано по позициям — без заданий и
    участков."""
    # Заказы «на склад» — пополнение остатка, продажнику не нужны.
    q = db.query(ProductionOrder).filter(ProductionOrder.status != ORDER_DRAFT, ProductionOrder.kind != ORDER_KIND_STOCK)
    if not include_closed:
        q = q.filter(ProductionOrder.status != ORDER_CLOSED)
    out = []
    for order in q.order_by(ProductionOrder.ship_date.asc().nullslast(), ProductionOrder.id.desc()):
        full = _order_out(db, order)
        lines = [ReadinessLineOut(item_name=ln.item_name, quantity=ln.quantity, done=min(ln.done, ln.quantity)) for ln in full.lines]
        if not lines:  # заказ из заданий — по строкам заданий
            lines = [ReadinessLineOut(item_name=t.name, quantity=t.planned, done=t.done) for t in full.tasks]
        out.append(
            ReadinessOut(
                id=order.id, name=order.name, status=order.status, ship_date=order.ship_date,
                plan_finish=full.plan_finish, plan_late=full.plan_late, plan_overdue=full.plan_overdue, planned=full.planned,
                quantity=round(sum(ln.quantity for ln in lines), 2), done=round(sum(ln.done for ln in lines), 2), lines=lines,
                stages=_readiness_stages(db, order),
            )
        )
    return out


@router.get("/production-orders/{order_id}", response_model=OrderOut)
def get_order(order_id: int, db: Session = Depends(get_db), user: User = Depends(view_orders)) -> OrderOut:
    return _order_out(db, _get_order(db, order_id))


def _kind(value: str) -> str:
    if value not in (ORDER_KIND_CUSTOMER, ORDER_KIND_STOCK):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Вид заказа — клиенту или на склад")
    return value


@router.post("/production-orders", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
def create_order(payload: OrderIn, db: Session = Depends(get_db), user: User = Depends(manage_orders)) -> OrderOut:
    name = " ".join(payload.name.split())
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите название заказа")
    if payload.ship_date is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите дату отгрузки — от неё считаются сроки операций")
    order = ProductionOrder(
        name=name, ship_date=payload.ship_date, note=(payload.note or "").strip() or None, status=ORDER_DRAFT, created_by=user.id,
        kind=_kind(payload.kind),
    )
    db.add(order)
    db.flush()
    _write_lines(db, order, payload.lines)
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


@router.put("/production-orders/{order_id}", response_model=OrderOut)
def update_order(order_id: int, payload: OrderIn, db: Session = Depends(get_db), user: User = Depends(manage_orders)) -> OrderOut:
    order = _get_order(db, order_id)
    if order.status != ORDER_DRAFT:
        raise HTTPException(status.HTTP_409_CONFLICT, "Запущенный заказ не правится — задания уже выданы участкам")
    name = " ".join(payload.name.split())
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите название заказа")
    order.name, order.ship_date, order.note = name, payload.ship_date, (payload.note or "").strip() or None
    order.kind = _kind(payload.kind)
    _write_lines(db, order, payload.lines)
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


@router.delete("/production-orders/{order_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_order(order_id: int, db: Session = Depends(get_db), user: User = Depends(manage_orders)) -> None:
    order = _get_order(db, order_id)
    if order.status != ORDER_DRAFT:
        raise HTTPException(status.HTTP_409_CONFLICT, "Удалить можно только черновик; запущенный — закройте")
    db.delete(order)
    db.commit()


class PfNeedOut(BaseModel):
    order_line_id: int
    part_id: int
    part_name: str
    quantity: float
    consumer_part_id: int | None
    depth: int
    free_stock: float
    from_stock: float = 0
    launch: float = 0
    mode: str | None = None
    lamination_area: str | None
    factory_area: str | None
    factory_min_pieces: float | None


@router.get("/production-orders/{order_id}/release-preview", response_model=list[PfNeedOut])
def release_preview(order_id: int, db: Session = Depends(get_db), user: User = Depends(view_orders)) -> list[PfNeedOut]:
    """Что из п/ф запустить вместе с заказом — по составу вглубь, на полное
    количество (п/ф щитовых делаются под заказ)."""
    order = _get_order(db, order_id)
    return [PfNeedOut(**{k: v for k, v in n.__dict__.items() if k != "consumer_stage_id"}) for n in order_pf_needs(db, order)]


class PfPickIn(BaseModel):
    order_line_id: int
    part_id: int
    quantity: float = Field(ge=0)  # запустить в производство
    consumer_part_id: int | None = None
    lamination_area: str | None = None
    from_stock: float = Field(default=0, ge=0)  # взять со склада — в резерв под заказ


class ReleaseIn(BaseModel):
    pf: list[PfPickIn] = []


@router.post("/production-orders/{order_id}/release", response_model=OrderOut)
def release(
    order_id: int, payload: ReleaseIn | None = None, db: Session = Depends(get_db), user: User = Depends(manage_orders)
) -> OrderOut:
    """Запуск: задания участкам по маршрутам, п/ф под заказ (что выбрано в
    окне запуска) и сроки операций назад от отгрузки."""
    order = _get_order(db, order_id)
    try:
        tasks = release_order(db, order, user.id)
        if payload and payload.pf:
            release_pf(db, order, tasks, [PfPick(**p.model_dump()) for p in payload.pf], user.id)
        schedule_order(db, order, user.id)
    except OrderError as e:
        db.rollback()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


@router.post("/production-orders/{order_id}/schedule", response_model=OrderOut)
def reschedule(order_id: int, db: Session = Depends(get_db), user: User = Depends(manage_orders)) -> OrderOut:
    """Пересчитать сроки: автоматические слоты заново, ручные — как есть."""
    order = _get_order(db, order_id)
    if order.status == ORDER_DRAFT:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Черновик ещё не запущен — сроков нет")
    schedule_order(db, order, user.id)
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


@router.post("/production-orders/{order_id}/complete", response_model=OrderOut)
def complete(order_id: int, db: Session = Depends(get_db), user: User = Depends(manage_orders)) -> OrderOut:
    """Закрыть заказ как сделанный полностью, без отчётов: остаток всех строк
    его заданий засчитывается без рулона (плёнку не трогает), заказ закрыт."""
    order = _get_order(db, order_id)
    try:
        tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id).all()
        complete_tasks(db, tasks, user.id)
        close_order(db, order)
    except OrderError as e:
        db.rollback()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


@router.post("/production-orders/{order_id}/close", response_model=OrderOut)
def close(order_id: int, db: Session = Depends(get_db), user: User = Depends(manage_orders)) -> OrderOut:
    order = _get_order(db, order_id)
    try:
        close_order(db, order)
    except OrderError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    db.refresh(order)
    return _order_out(db, order)



class ScheduleImportIn(BaseModel):
    text: str
    type_id: int
    name: str | None = None
    dry_run: bool = True


class ScheduleRowOut(BaseModel):
    series: str
    size: str
    color: str
    name_text: str
    qty: int
    invoice_no: str
    ship_date: str | None
    item_name: str | None
    exists: bool
    errors: list[str]


class ScheduleImportOut(BaseModel):
    rows: list[ScheduleRowOut]
    parse_errors: list[str]
    order: OrderOut | None


@router.post("/production-orders/from-schedule", response_model=ScheduleImportOut)
def order_from_schedule(
    payload: ScheduleImportIn, db: Session = Depends(get_db), user: User = Depends(manage_orders)
) -> ScheduleImportOut:
    """График запуска (вставлен из Excel) → черновик заказа: строка графика
    — позиция по типу (находится или создаётся с техкартой по правилам) и
    строка заказа. dry_run — только предпросмотр; с ошибками заказ не
    создаётся."""
    type_ = db.get(ItemType, payload.type_id)
    if type_ is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Тип не найден")
    rows, parse_errors, order = import_schedule(
        db, text=payload.text, type_=type_, order_name=payload.name, user_id=user.id, dry_run=payload.dry_run
    )
    if order is not None:
        db.commit()
        db.refresh(order)
    else:
        db.rollback()
    return ScheduleImportOut(
        rows=[ScheduleRowOut(**{k: getattr(r, k) for k in ScheduleRowOut.model_fields}) for r in rows],
        parse_errors=parse_errors,
        order=_order_out(db, order) if order is not None else None,
    )

