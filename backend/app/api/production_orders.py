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
from app.models.items import Item, ItemComponent, ItemKind
from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.production_orders import ORDER_CLOSED, ORDER_DRAFT, ProductionOrder, ProductionOrderLine
from app.models.users import User
from app.services.components import live_item_names
from app.services.production_orders import OrderError, close_order, release_order
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


class OrderOut(BaseModel):
    id: int
    name: str
    ship_date: date | None
    note: str | None
    status: str
    created_by_name: str
    created_at: datetime
    released_at: datetime | None
    task_ids: list[int]
    lines: list[OrderLineOut]


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
        comps = db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id).order_by(ItemComponent.sort_order).all()
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
    task_ids = [t.id for t in db.query(ProductionTask.id).filter(ProductionTask.production_order_id == order.id)]
    return OrderOut(
        id=order.id, name=order.name, ship_date=order.ship_date, note=order.note, status=order.status,
        created_by_name=(author.full_name or author.username) if author else "—", created_at=order.created_at,
        released_at=order.released_at, task_ids=task_ids, lines=out_lines,
    )


def _get_order(db: Session, order_id: int) -> ProductionOrder:
    order = db.get(ProductionOrder, order_id)
    if order is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заказ не найден")
    return order


def _write_lines(db: Session, order: ProductionOrder, lines: list[OrderLineIn]) -> None:
    order.lines.clear()
    db.flush()
    for i, ln in enumerate(lines, start=1):
        if db.get(Item, ln.item_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
        order.lines.append(
            ProductionOrderLine(item_id=ln.item_id, quantity=ln.quantity, note=(ln.note or "").strip() or None, sort_order=i)
        )


@router.get("/production-orders", response_model=list[OrderOut])
def list_orders(
    include_closed: bool = Query(default=False),
    item_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(view_orders),
) -> list[OrderOut]:
    q = db.query(ProductionOrder)
    if item_id is not None:
        # Заказы, где есть позиция (для вкладки «Заказы» карточки позиции).
        q = q.filter(ProductionOrder.lines.any(ProductionOrderLine.item_id == item_id))
    if not include_closed:
        q = q.filter(ProductionOrder.status != ORDER_CLOSED)
    return [_order_out(db, o) for o in q.order_by(ProductionOrder.id.desc())]


@router.get("/production-orders/{order_id}", response_model=OrderOut)
def get_order(order_id: int, db: Session = Depends(get_db), user: User = Depends(view_orders)) -> OrderOut:
    return _order_out(db, _get_order(db, order_id))


@router.post("/production-orders", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
def create_order(payload: OrderIn, db: Session = Depends(get_db), user: User = Depends(manage_orders)) -> OrderOut:
    name = " ".join(payload.name.split())
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите название заказа")
    order = ProductionOrder(
        name=name, ship_date=payload.ship_date, note=(payload.note or "").strip() or None, status=ORDER_DRAFT, created_by=user.id
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


@router.post("/production-orders/{order_id}/release", response_model=OrderOut)
def release(order_id: int, db: Session = Depends(get_db), user: User = Depends(manage_orders)) -> OrderOut:
    order = _get_order(db, order_id)
    try:
        release_order(db, order, user.id)
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
