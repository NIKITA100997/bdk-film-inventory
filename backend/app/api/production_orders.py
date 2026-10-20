"""Заказы на производство (единая модель, пункт 4): что и сколько сделать —
позиции номенклатуры любого вида; запуск раскладывает заказ по маршрутам
позиций на задания участкам, прогресс — по отчётам этих заданий."""

from collections import defaultdict
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import get_permission_codes, require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import PartStage
from app.models.items import Item, ItemComponent, ItemKind
from app.models.production import PlanSlot, ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.production_orders import (
    OrderCategory,
    ORDER_CLOSED,
    ORDER_DRAFT,
    ORDER_KIND_CUSTOMER,
    ORDER_KIND_STOCK,
    ORDER_RELEASED,
    OrderDateChange,
    ProductionOrder,
    ProductionOrderLine,
)
from app.models.users import User
from app.services.components import live_item_names, planned_components
from app.services.planning import PfPick, order_pf_needs, order_plan_status, release_pf, schedule_order
from app.services.production_orders import OrderError, close_order, complete_tasks, release_order
from app.services.schedule_import import import_schedule
from app.services.type_rules import item_chars_cached
from app.services.order_requests import REQ_ACCEPTED, REQ_RETURNED, REQ_SUBMITTED
from app.models.items import ItemType

router = APIRouter(tags=["production-orders"])

view_orders = require_permission(
    "production_tasks.manage", "production_tasks.view", "production_tasks.report", "orders.request", "sales_calculator.view"
)
manage_orders = require_permission("production_tasks.manage")
# Заказ на производство заводит и правит только производство (19.10):
# менеджер работает с заказом клиента (счёт 1С), из принятых заказов
# клиентов производство собирает запуск. Прежние «заявки» продажника
# (09.10) прямо в заказ на производство закрыты.
edit_orders = require_permission("production_tasks.manage")


def _can_manage(user: User) -> bool:
    return user.is_superuser or "production_tasks.manage" in get_permission_codes(user)


def _check_editable(order: ProductionOrder, user: User) -> None:
    """Продажник правит только свой этап: черновик до отправки или возвращённый."""
    if _can_manage(user):
        return
    if order.status != ORDER_DRAFT or order.request_status in (REQ_SUBMITTED, REQ_ACCEPTED):
        raise HTTPException(status.HTTP_409_CONFLICT, "Заявка уже у производства — изменить её может начальник цеха")


class OrderLineIn(BaseModel):
    item_id: int
    quantity: float = Field(gt=0)
    note: str | None = None
    invoice_no: str | None = None  # счёт / заказ 1С


class OrderIn(BaseModel):
    name: str
    ship_date: date | None = None
    # вилка отгрузки менеджера (09.10)
    ship_from: date | None = None
    ship_to: date | None = None
    # из счёта и от менеджера (12.10)
    customer: str | None = Field(default=None, max_length=255)
    amount_rub: float | None = Field(default=None, ge=0)
    priority: int = Field(default=0, ge=0, le=2)
    # обещанная готовность — ставит производство
    promised_ready: date | None = None
    note: str | None = None
    kind: str = ORDER_KIND_CUSTOMER  # customer | stock
    category_id: int | None = None
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
    depth: int = 0  # уровень в полном составе (composition): 0 — прямо в изделии


def _composition(db: Session, item_id: int, qty: float, kinds: dict, cache: dict | None = None, max_depth: int = 5) -> list[ComponentNeed]:
    """Полный состав изделия деревом (20.10): изделие → щит, каркас, панели →
    их заготовки…; «на изделие» — сколько на одну штуку строки, «всего» — на
    количество строки. Порядок — как в дереве (родитель, затем его состав)."""
    if cache is not None and item_id in cache:
        return [c.model_copy(update={"total": round(c.per_unit * qty, 2)}) for c in cache[item_id]]
    out: list[ComponentNeed] = []

    def walk(parent_id: int, per_unit: float, depth: int, seen: frozenset[int]) -> None:
        comps = planned_components(db.query(ItemComponent).filter(ItemComponent.parent_item_id == parent_id).all())
        if not comps:
            return
        names = live_item_names(db, {c.component_item_id for c in comps})
        items = {i.id: i for i in db.query(Item).filter(Item.id.in_([c.component_item_id for c in comps]))}
        for c in comps:
            per = per_unit * float(c.qty_per_unit)
            st = db.get(PartStage, c.stage_id) if c.stage_id else None
            it = items.get(c.component_item_id)
            out.append(
                ComponentNeed(
                    item_id=c.component_item_id, name=names.get(c.component_item_id, "—"), per_unit=round(per, 4),
                    total=round(per * qty, 2), unit=kinds[it.kind_id].unit if it else "шт",
                    operation_name=st.name if st else None, depth=depth,
                )
            )
            if depth + 1 < max_depth and c.component_item_id not in seen:
                walk(c.component_item_id, per, depth + 1, seen | {c.component_item_id})

    walk(item_id, 1.0, 0, frozenset({item_id}))
    if cache is not None:
        cache[item_id] = out
    return out


class OrderLineOut(BaseModel):
    id: int
    item_id: int
    item_name: str
    kind_name: str
    # характеристики позиции (серия, размер, цвет, кромка…) — показ колонками
    item_chars: list[dict] = []
    quantity: float
    note: str | None
    invoice_no: str | None = None
    done: float  # готово по последней операции маршрута (без этапов — приход на склад ГП)
    without_route: bool = False  # изделие без этапов: «в работе» → «Готово» отметкой (16.10)
    operations: list[OperationProgress]
    components: list[ComponentNeed]
    # полный состав деревом (20.10) — «из чего состоит изделие» в черновике
    composition: list[ComponentNeed] = []


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
    category_id: int | None = None
    category_name: str | None = None
    created_by_name: str
    created_at: datetime
    released_at: datetime | None
    task_ids: list[int]
    lines: list[OrderLineOut]
    ship_from: date | None = None
    ship_to: date | None = None
    request_status: str | None = None
    request_comment: str | None = None
    submitted_at: datetime | None = None
    submitted_by_name: str | None = None
    decided_by_name: str | None = None
    customer: str | None = None
    amount_rub: float | None = None
    priority: int = 0
    promised_ready: date | None = None
    # факт (12.10): готовность — вручную или по приходу всего на склад ГП;
    # принято на склад и отгружено, шт; последняя отгрузка
    ready_fact: date | None = None
    received_qty: float = 0
    shipped_qty: float = 0
    last_shipped_at: date | None = None
    date_changes: list["DateChangeOut"] = []
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

    from app.services.finished_goods import totals_by_order_line
    from app.services.production_orders import without_route

    fg = totals_by_order_line(db, [ln.id for ln in order.lines])
    out_lines = []
    comp_cache: dict = {}
    for ln in order.lines:
        item = db.get(Item, ln.item_id)
        simple = without_route(item)
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
                item_chars=item_chars_cached(db, item.id),
                quantity=float(ln.quantity), note=ln.note, invoice_no=ln.invoice_no,
                done=fg.get(ln.id, {}).get("received", 0.0) if simple else (ops[-1].good if ops else 0.0),
                without_route=simple, operations=ops,
                components=[
                    ComponentNeed(
                        item_id=c.component_item_id, name=comp_names.get(c.component_item_id, "—"),
                        per_unit=float(c.qty_per_unit), total=round(float(c.qty_per_unit) * float(ln.quantity), 2),
                        unit=kinds[comp_items[c.component_item_id].kind_id].unit if c.component_item_id in comp_items else "шт",
                        operation_name=stage_names.get(c.stage_id) if c.stage_id else None,
                    )
                    for c in comps
                ],
                composition=_composition(db, item.id, float(ln.quantity), kinds, comp_cache),
            )
        )
    author = db.get(User, order.created_by)
    tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id).order_by(ProductionTask.id).all()
    return OrderOut(
        id=order.id, name=order.name, ship_date=order.ship_date, note=order.note, status=order.status, kind=order.kind,
        category_id=order.category_id,
        category_name=(db.get(OrderCategory, order.category_id).name if order.category_id else None),
        created_by_name=(author.full_name or author.username) if author else "—", created_at=order.created_at,
        released_at=order.released_at, task_ids=[t.id for t in tasks], lines=out_lines,
        ship_from=order.ship_from, ship_to=order.ship_to, request_status=order.request_status,
        request_comment=order.request_comment, submitted_at=order.submitted_at,
        submitted_by_name=_user_name(db, order.submitted_by), decided_by_name=_user_name(db, order.decided_by),
        customer=order.customer, amount_rub=float(order.amount_rub) if order.amount_rub is not None else None,
        priority=order.priority or 0, promised_ready=order.promised_ready,
        **_fact_fields(db, order),
        tasks=_tasks_out(db, tasks, area_names),
        **_plan_fields(db, order),
    )


class DateChangeOut(BaseModel):
    field: str
    old_date: date | None
    new_date: date | None
    reason: str | None
    reason_name: str | None
    comment: str | None
    user_name: str | None
    created_at: datetime


DATE_CHANGE_REASONS = {
    "material": "Нет материала",
    "capacity": "Перегруз участка",
    "client": "Просьба клиента",
    "defect": "Брак, переделка",
    "equipment": "Поломка оборудования",
    "calendar": "Нерабочий день",
    "urgent": "Вставили срочный заказ",
    "other": "Другое",
}


def _fact_fields(db: Session, order: ProductionOrder) -> dict:
    """Факт по складу ГП: принято, отгружено, дата готовности и последней отгрузки."""
    from app.models.finished_goods import FG_RECEIPT, FgMove

    ol_ids = [ln.id for ln in order.lines]
    received = shipped = 0.0
    ready = order.ready_at
    last_ship = None
    if ol_ids:
        rec_by_line: dict[int, float] = defaultdict(float)
        last_rec = None
        for m in db.query(FgMove).filter(FgMove.order_line_id.in_(ol_ids)):
            q = float(m.qty)
            if m.kind == FG_RECEIPT:
                rec_by_line[m.order_line_id] += q
                last_rec = max(last_rec, m.occurred_at) if last_rec else m.occurred_at
            elif m.kind in ("shipment", "unship", "return"):
                shipped -= q
                if m.kind == "shipment":
                    last_ship = max(last_ship, m.occurred_at) if last_ship else m.occurred_at
        received = sum(rec_by_line.values())
        if ready is None and last_rec and all(rec_by_line.get(ln.id, 0.0) >= float(ln.quantity) for ln in order.lines):
            ready = last_rec.astimezone().date()
    changes = (
        db.query(OrderDateChange).filter(OrderDateChange.order_id == order.id).order_by(OrderDateChange.created_at.desc()).all()
    )
    return {
        "ready_fact": ready,
        "received_qty": round(received, 2),
        "shipped_qty": round(shipped, 2),
        "last_shipped_at": last_ship.astimezone().date() if last_ship else None,
        "date_changes": [
            DateChangeOut(
                field=c.field, old_date=c.old_date, new_date=c.new_date, reason=c.reason,
                reason_name=DATE_CHANGE_REASONS.get(c.reason or ""), comment=c.comment,
                user_name=_user_name(db, c.user_id), created_at=c.created_at,
            )
            for c in changes
        ],
    }


def _log_date(db: Session, order: ProductionOrder, field: str, old: date | None, new: date | None, user_id: int,
              reason: str | None = None, comment: str | None = None) -> None:
    if old == new:
        return
    db.add(OrderDateChange(order_id=order.id, field=field, old_date=old, new_date=new, reason=reason,
                           comment=(comment or "").strip() or None, user_id=user_id))


def _user_name(db: Session, user_id: int | None) -> str | None:
    u = db.get(User, user_id) if user_id else None
    return (u.full_name or u.username) if u else None


def _window(ship_from: date | None, ship_to: date | None) -> None:
    if ship_from and ship_to and ship_from > ship_to:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Вилка отгрузки: «с» позже, чем «по»")


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
            ProductionOrderLine(
                item_id=ln.item_id, quantity=ln.quantity, note=(ln.note or "").strip() or None,
                invoice_no=(ln.invoice_no or "").strip() or None, sort_order=i,
            )
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


def _readiness_stages(db: Session, order: ProductionOrder, order_line_ids: set[int] | None = None) -> list[ReadinessStageOut]:
    """Этапы заказа для продажника: операции изделия (по названию, в порядке
    маршрута), п/ф — одной колонкой; у заказа из заданий — по участкам."""
    from collections import defaultdict as _dd
    from datetime import date as _date

    tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id).all()
    lines = [(ln, t) for t in tasks for ln in t.lines if order_line_ids is None or ln.order_line_id in order_line_ids]
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


class InvoiceReadinessOut(BaseModel):
    """Готовность по счёту 1С — то, что продажник обещал клиенту: строки
    счёта могут быть в разных запусках."""

    invoice: str  # «без счёта» — строки без номера (по заказу)
    orders: list[str]
    ship_date: date | None
    plan_finish: date | None
    plan_late: bool
    plan_overdue: float
    planned: bool
    quantity: float
    done: float
    closed: bool
    lines: list[ReadinessLineOut]
    stages: list[ReadinessStageOut] = []
    # монитор по счетам (12.10, этап 4): клиент, обещанная готовность,
    # отгружено; state — в работе / принят, не запущен / заявка ждёт приёма
    customer: str | None = None
    promised_ready: date | None = None
    shipped: float = 0
    state: str = "в работе"


@router.get("/production-orders/readiness-invoices", response_model=list[InvoiceReadinessOut])
def invoices_readiness(
    include_closed: bool = False, db: Session = Depends(get_db), user: User = Depends(view_readiness)
) -> list[InvoiceReadinessOut]:
    """Готовность по счетам: этапы, срок по плану и «успевает ли» — по строкам
    счёта во всех запусках. Строки без счёта — по своему заказу."""
    from sqlalchemy import or_ as _or

    from app.services.finished_goods import totals_by_order_line

    q = db.query(ProductionOrder).filter(
        _or(ProductionOrder.status != ORDER_DRAFT, ProductionOrder.request_status.in_(["accepted", "submitted"])),
        ProductionOrder.kind != ORDER_KIND_STOCK,
    )
    if not include_closed:
        q = q.filter(ProductionOrder.status != ORDER_CLOSED)
    groups: dict[str, dict] = {}
    for order in q:
        full = _order_out(db, order)
        by_line = {ln.id: ln for ln in full.lines}
        fg = totals_by_order_line(db, [ln.id for ln in order.lines])
        keys: dict[str, set[int]] = defaultdict(set)
        for ln in order.lines:
            keys[ln.invoice_no or f"без счёта · №{order.id} «{order.name}»"].add(ln.id)
        state = "в работе" if order.status != ORDER_DRAFT else ("принят, не запущен" if order.request_status == "accepted" else "заявка ждёт приёма")
        for key, ids in keys.items():
            g = groups.setdefault(key, {"orders": [], "ship": None, "lines": [], "stages": [], "closed": True,
                                        "customer": None, "ready": None, "shipped": 0.0, "states": set()})
            g["orders"].append(f"№{order.id} «{order.name}»")
            g["customer"] = g["customer"] or order.customer
            g["states"].add(state)
            g["shipped"] += sum(fg.get(i, {}).get("shipped", 0.0) for i in ids)
            if order.promised_ready and (g["ready"] is None or order.promised_ready > g["ready"]):
                g["ready"] = order.promised_ready
            if order.ship_date and (g["ship"] is None or order.ship_date < g["ship"]):
                g["ship"] = order.ship_date
            g["closed"] = g["closed"] and order.status == ORDER_CLOSED
            g["lines"] += [
                ReadinessLineOut(item_name=by_line[i].item_name, quantity=by_line[i].quantity, done=min(by_line[i].done, by_line[i].quantity))
                for i in ids if i in by_line
            ]
            g["stages"] += _readiness_stages(db, order, ids)
    out = []
    for key, g in groups.items():
        merged: dict[str, dict] = {}
        for st in g["stages"]:
            m = merged.setdefault(st.name, {"seq": st.seq, "plan": 0.0, "done": 0.0, "date": None, "st": []})
            m["plan"] += st.plan
            m["done"] += st.done
            m["st"].append(st.status)
            if st.plan_date and (m["date"] is None or st.plan_date > m["date"]):
                m["date"] = st.plan_date
        stages = []
        for name, m in merged.items():
            sts = m["st"]
            status_ = ("done" if all(x == "done" for x in sts) else "overdue" if "overdue" in sts
                       else "progress" if "progress" in sts or "done" in sts else "planned" if "planned" in sts else "none")
            stages.append(ReadinessStageOut(name=name, seq=m["seq"], plan=round(m["plan"], 2), done=round(m["done"], 2),
                                            plan_date=m["date"], status=status_))
        stages.sort(key=lambda x: (x.seq, x.name))
        dates = [s_.plan_date for s_ in stages if s_.plan_date]
        finish = max(dates) if dates else None
        overdue = max([s_.plan - s_.done for s_ in stages if s_.status == "overdue"] or [0.0])
        out.append(InvoiceReadinessOut(
            invoice=key, orders=g["orders"], ship_date=g["ship"], plan_finish=finish,
            plan_late=bool(finish and g["ship"] and finish > g["ship"]), plan_overdue=round(overdue, 2), planned=bool(dates),
            quantity=round(sum(ln.quantity for ln in g["lines"]), 2), done=round(sum(ln.done for ln in g["lines"]), 2),
            closed=g["closed"], lines=g["lines"], stages=stages,
            customer=g["customer"], promised_ready=g["ready"], shipped=round(g["shipped"], 2),
            state="заявка ждёт приёма" if "заявка ждёт приёма" in g["states"] else "принят, не запущен" if "принят, не запущен" in g["states"] else "в работе",
        ))
    return sorted(out, key=lambda x: (x.ship_date or date.max, x.invoice))


@router.get("/production-orders/{order_id}", response_model=OrderOut)
def get_order(order_id: int, db: Session = Depends(get_db), user: User = Depends(view_orders)) -> OrderOut:
    return _order_out(db, _get_order(db, order_id))


class ReleaseSettingsIO(BaseModel):
    # формат — у экрана запуска: {pf: {...}, overrides: {...}, plan: {...}}
    settings: dict | None = None
    updated_at: datetime | None = None


@router.get("/production-orders/{order_id}/release-settings", response_model=ReleaseSettingsIO)
def get_release_settings(order_id: int, db: Session = Depends(get_db), user: User = Depends(view_orders)) -> ReleaseSettingsIO:
    """Сохранённая настройка запуска черновика — вернуться к ней позже."""
    order = _get_order(db, order_id)
    raw = order.release_settings or {}
    return ReleaseSettingsIO(settings=raw.get("settings"), updated_at=raw.get("updated_at"))


@router.put("/production-orders/{order_id}/release-settings", response_model=ReleaseSettingsIO)
def save_release_settings(
    order_id: int, payload: ReleaseSettingsIO, db: Session = Depends(get_db), user: User = Depends(manage_orders)
) -> ReleaseSettingsIO:
    """Сохранить настройку запуска черновика (п/ф, площадки, правки строк,
    сроки) — по ходу настройки, без запуска."""
    import json

    order = _get_order(db, order_id)
    if order.status != ORDER_DRAFT:
        raise HTTPException(status.HTTP_409_CONFLICT, "Заказ уже запущен — настройка запуска не меняется")
    if payload.settings is not None and len(json.dumps(payload.settings, ensure_ascii=False)) > 500_000:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Слишком большая настройка запуска")
    now = datetime.now(timezone.utc)
    order.release_settings = {"settings": payload.settings, "updated_at": now.isoformat(), "user_id": user.id}
    db.commit()
    return ReleaseSettingsIO(settings=payload.settings, updated_at=now)


def _category(db: Session, category_id: int | None) -> int | None:
    if category_id is not None and db.get(OrderCategory, category_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Категория не найдена")
    return category_id


class OrderCategoryOut(BaseModel):
    id: int
    name: str
    is_active: bool


class OrderCategoryIn(BaseModel):
    name: str
    is_active: bool = True


@router.get("/order-categories", response_model=list[OrderCategoryOut])
def list_order_categories(db: Session = Depends(get_db), user: User = Depends(view_orders)) -> list[OrderCategoryOut]:
    return [OrderCategoryOut(id=c.id, name=c.name, is_active=c.is_active) for c in db.query(OrderCategory).order_by(OrderCategory.name)]


@router.post("/order-categories", response_model=OrderCategoryOut, status_code=status.HTTP_201_CREATED)
def create_order_category(payload: OrderCategoryIn, db: Session = Depends(get_db), user: User = Depends(manage_orders)) -> OrderCategoryOut:
    name = " ".join(payload.name.split())
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите название категории")
    if db.query(OrderCategory).filter(func.lower(OrderCategory.name) == name.lower()).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Такая категория уже есть")
    c = OrderCategory(name=name, is_active=payload.is_active)
    db.add(c)
    db.commit()
    return OrderCategoryOut(id=c.id, name=c.name, is_active=c.is_active)


@router.patch("/order-categories/{category_id}", response_model=OrderCategoryOut)
def update_order_category(
    category_id: int, payload: OrderCategoryIn, db: Session = Depends(get_db), user: User = Depends(manage_orders)
) -> OrderCategoryOut:
    c = db.get(OrderCategory, category_id)
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Категория не найдена")
    name = " ".join(payload.name.split())
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите название категории")
    c.name, c.is_active = name, payload.is_active
    db.commit()
    return OrderCategoryOut(id=c.id, name=c.name, is_active=c.is_active)


def _kind(value: str) -> str:
    if value not in (ORDER_KIND_CUSTOMER, ORDER_KIND_STOCK):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Вид заказа — клиенту или на склад")
    return value


@router.post("/production-orders", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
def create_order(payload: OrderIn, db: Session = Depends(get_db), user: User = Depends(edit_orders)) -> OrderOut:
    name = " ".join(payload.name.split())
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите название заказа")
    manager = _can_manage(user)
    # Твёрдую дату ставит производство; продажник — вилку.
    ship_date = payload.ship_date if manager else None
    if ship_date is None and payload.ship_to is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Укажите дату отгрузки — от неё считаются сроки операций" if manager else "Укажите вилку отгрузки: с какого и по какое число",
        )
    _window(payload.ship_from, payload.ship_to)
    order = ProductionOrder(
        name=name, ship_date=ship_date, note=(payload.note or "").strip() or None, status=ORDER_DRAFT, created_by=user.id,
        kind=_kind(payload.kind), category_id=_category(db, payload.category_id),
        ship_from=payload.ship_from, ship_to=payload.ship_to,
        customer=(payload.customer or "").strip() or None, amount_rub=payload.amount_rub, priority=payload.priority,
        promised_ready=payload.promised_ready if manager else None,
    )
    db.add(order)
    db.flush()
    _write_lines(db, order, payload.lines)
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


@router.put("/production-orders/{order_id}", response_model=OrderOut)
def update_order(order_id: int, payload: OrderIn, db: Session = Depends(get_db), user: User = Depends(edit_orders)) -> OrderOut:
    order = _get_order(db, order_id)
    if order.status != ORDER_DRAFT:
        raise HTTPException(status.HTTP_409_CONFLICT, "Запущенный заказ не правится — задания уже выданы участкам")
    _check_editable(order, user)
    name = " ".join(payload.name.split())
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите название заказа")
    _window(payload.ship_from, payload.ship_to)
    if _can_manage(user):
        order.ship_date = payload.ship_date
    order.name, order.note = name, (payload.note or "").strip() or None
    order.ship_from, order.ship_to = payload.ship_from, payload.ship_to
    order.customer, order.amount_rub = (payload.customer or "").strip() or None, payload.amount_rub
    order.priority = payload.priority
    if _can_manage(user):
        order.promised_ready = payload.promised_ready
    order.kind = _kind(payload.kind)
    order.category_id = _category(db, payload.category_id)
    _write_lines(db, order, payload.lines)
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


@router.delete("/production-orders/{order_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_order(order_id: int, db: Session = Depends(get_db), user: User = Depends(edit_orders)) -> None:
    order = _get_order(db, order_id)
    _check_editable(order, user)
    if order.status != ORDER_DRAFT:
        raise HTTPException(status.HTTP_409_CONFLICT, "Удалить можно только черновик; запущенный — закройте")
    if db.query(ProductionTask.id).filter(ProductionTask.production_order_id == order.id).first():
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "По заказу уже запущена окутка панелей — сначала уберите её задания (или запустите и закройте заказ)",
        )
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


class LineOverrideIn(BaseModel):
    """Ручная правка строки, что родится при запуске (см. release_overrides)."""

    key: str
    quantity: float | None = Field(default=None, gt=0)
    program: str | None = None
    instruction: str | None = None
    material_sku_id: int | None = None
    strip_width_mm: float | None = Field(default=None, gt=0)
    area: str | None = None
    skip: bool = False


class AreaDateIn(BaseModel):
    area: str
    date: date


class ReleaseIn(BaseModel):
    pf: list[PfPickIn] = []
    overrides: list[LineOverrideIn] = []
    # Ручные сроки до запуска: участок — на дату, весь заказ — сдвиг.
    dates: list[AreaDateIn] = []
    shift_days: int = 0
    shift_next: bool = True


@router.post("/production-orders/{order_id}/release", response_model=OrderOut)
def release(
    order_id: int, payload: ReleaseIn | None = None, db: Session = Depends(get_db), user: User = Depends(manage_orders)
) -> OrderOut:
    """Запуск: задания участкам по маршрутам, п/ф под заказ (что выбрано в
    окне запуска) и сроки операций назад от отгрузки."""
    order = _get_order(db, order_id)
    if order.request_status == REQ_SUBMITTED and order.ship_date is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Сначала примите заявку — поставьте дату отгрузки")
    try:
        tasks = release_order(db, order, user.id)
        if payload and payload.pf:
            release_pf(db, order, tasks, [PfPick(**p.model_dump()) for p in payload.pf], user.id)
        from app.services.milling_programs import fill_programs

        fill_programs(db, order)  # программы фрезеровки — до ручных правок
        if payload and payload.overrides:
            from app.services.release_overrides import LineOverride, apply_overrides

            errs = apply_overrides(db, order, [LineOverride(**o.model_dump()) for o in payload.overrides], user.full_name or user.username)
            if errs:
                raise OrderError("; ".join(errs))
        from app.services.release_merge import merge_pf_lines

        merge_pf_lines(db, order)  # одинаковые строки п/ф — одной (08.10)
        schedule_order(db, order, user.id)
        if payload and (payload.dates or payload.shift_days):
            from app.services.planning import apply_release_dates

            apply_release_dates(db, order, {d.area: d.date for d in payload.dates}, payload.shift_days, user.id, payload.shift_next)
        # резерв плёнки под заказ (15.10): резерв заказов клиентов этого
        # запуска переходит в резерв строк заданий
        from app.services import film_reserve

        if film_reserve.enabled(db):
            from app.models.customer_orders import CustomerOrderLine

            co_ids = {
                co for (co,) in db.query(CustomerOrderLine.order_id).filter(
                    CustomerOrderLine.id.in_([ol.customer_order_line_id for ol in order.lines if ol.customer_order_line_id] or [-1])
                )
            }
            for co_id in co_ids:
                film_reserve.release_customer_order(db, co_id, user.id, "переведён в задания при запуске")
            db.flush()
            all_tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id).all()
            film_reserve.reserve_lines(db, [ln for t in all_tasks for ln in t.lines], user.id)
    except OrderError as e:
        db.rollback()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


@router.post("/production-orders/{order_id}/release-layout")
def release_layout(
    order_id: int, payload: ReleaseIn | None = None, db: Session = Depends(get_db), user: User = Depends(manage_orders)
) -> dict:
    """Раскладка перед запуском: что родится по участкам (как листы Excel),
    плёнка и материалы, предупреждения. Запуск выполняется по-настоящему и
    откатывается — в базе ничего не остаётся."""
    from app.services.release_layout import build_release_layout

    order = _get_order(db, order_id)
    try:
        from app.services.release_overrides import LineOverride

        return build_release_layout(
            db, order, [PfPick(**p.model_dump()) for p in (payload.pf if payload else [])], user.id,
            overrides=[LineOverride(**o.model_dump()) for o in (payload.overrides if payload else [])],
            user_name=user.full_name or user.username,
            area_dates={d.area: d.date for d in (payload.dates if payload else [])},
            shift_days=payload.shift_days if payload else 0,
            shift_next=payload.shift_next if payload else True,
        )
    except OrderError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    finally:
        db.rollback()


class LamRowOut(BaseModel):
    part_id: int
    part_name: str
    quantity: float
    launched: float
    press_area: str | None
    factory_area: str | None
    factory_min_pieces: float | None
    film: str | None
    strip_mm: dict[str, float | None]


@router.get("/production-orders/{order_id}/lamination", response_model=list[LamRowOut])
def lamination_preview(order_id: int, db: Session = Depends(get_db), user: User = Depends(view_orders)) -> list[LamRowOut]:
    """Панели заказа с операцией плёнки: сколько нужно и сколько окутки уже
    запущено отдельно (09.10)."""
    from app.services.lamination_prelaunch import lamination_rows

    return [LamRowOut(**r.__dict__) for r in lamination_rows(db, _get_order(db, order_id))]


class LamPickIn(BaseModel):
    part_id: int
    quantity: float = Field(gt=0)
    area: str


class LamReleaseIn(BaseModel):
    items: list[LamPickIn]


@router.post("/production-orders/{order_id}/release-lamination", response_model=OrderOut)
def release_lamination_only(
    order_id: int, payload: LamReleaseIn, db: Session = Depends(get_db), user: User = Depends(manage_orders)
) -> OrderOut:
    """Окутка панелей отдельно: задания на ламинацию до запуска заказа
    (Фабрика — широкоформатная окутка, или прессы). Заказ остаётся
    черновиком; при его запуске эта окутка не повторяется."""
    from app.services.lamination_prelaunch import LamPick, release_lamination

    order = _get_order(db, order_id)
    try:
        release_lamination(db, order, [LamPick(**i.model_dump()) for i in payload.items], user.id)
    except OrderError as e:
        db.rollback()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


class PlanCheckAreaOut(BaseModel):
    area: str
    name: str
    order_pieces: float
    queue_pieces: float
    per_day: float | None
    days: int | None


class PlanCheckOut(BaseModel):
    earliest: date | None
    by_route: date | None
    bottleneck: str | None
    fits: bool | None
    areas: list[PlanCheckAreaOut]
    error: str | None = None


@router.get("/production-orders/{order_id}/plan-check", response_model=PlanCheckOut)
def order_plan_check(order_id: int, db: Session = Depends(get_db), user: User = Depends(view_orders)) -> PlanCheckOut:
    """Заявка (09.10): когда раньше всего может быть готово — по срокам
    операций и загрузке участков. Запуск выполняется и откатывается."""
    from app.services.order_requests import plan_check

    order = _get_order(db, order_id)
    if order.status != ORDER_DRAFT:
        raise HTTPException(status.HTTP_409_CONFLICT, "Заказ уже запущен — смотрите план")
    try:
        r = plan_check(db, order, user.id)
        return PlanCheckOut(
            earliest=r.earliest, by_route=r.by_route, bottleneck=r.bottleneck, fits=r.fits, error=r.error,
            areas=[PlanCheckAreaOut(**a.__dict__) for a in r.areas],
        )
    finally:
        db.rollback()


class RequestDecisionIn(BaseModel):
    comment: str | None = Field(default=None, max_length=500)
    ship_date: date | None = None
    ready_date: date | None = None  # обещанная готовность (12.10)


@router.post("/production-orders/{order_id}/submit", response_model=OrderOut)
def submit_request(
    order_id: int, payload: RequestDecisionIn | None = None, db: Session = Depends(get_db), user: User = Depends(edit_orders)
) -> OrderOut:
    """Менеджер отправляет заявку в производство."""
    order = _get_order(db, order_id)
    _check_editable(order, user)
    if order.status != ORDER_DRAFT or not order.lines:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Отправить можно черновик со строками")
    if order.ship_to is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите вилку отгрузки")
    order.request_status = REQ_SUBMITTED
    order.request_comment = ((payload.comment or "").strip() or None) if payload else None
    order.submitted_at, order.submitted_by = datetime.now(timezone.utc), user.id
    order.decided_by = None
    order.decided_at = None
    from app.services import bitrix

    bitrix.on_request_submitted(db, order, user)
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


@router.post("/production-orders/{order_id}/return", response_model=OrderOut)
def return_request(
    order_id: int, payload: RequestDecisionIn, db: Session = Depends(get_db), user: User = Depends(manage_orders)
) -> OrderOut:
    """Производство возвращает заявку менеджеру с комментарием."""
    order = _get_order(db, order_id)
    if order.request_status != REQ_SUBMITTED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Вернуть можно только отправленную заявку")
    comment = (payload.comment or "").strip()
    if not comment:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Напишите, почему возвращаете")
    order.request_status, order.request_comment = REQ_RETURNED, comment
    order.decided_by, order.decided_at = user.id, datetime.now(timezone.utc)
    from app.services import bitrix

    bitrix.on_request_decided(db, order, accepted=False)
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


@router.post("/production-orders/{order_id}/accept", response_model=OrderOut)
def accept_request(
    order_id: int, payload: RequestDecisionIn, db: Session = Depends(get_db), user: User = Depends(manage_orders)
) -> OrderOut:
    """Производство принимает заявку: твёрдая дата отгрузки (100%)."""
    order = _get_order(db, order_id)
    if order.request_status != REQ_SUBMITTED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Принять можно только отправленную заявку")
    if payload.ship_date is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите дату отгрузки")
    if payload.ready_date and payload.ready_date > payload.ship_date:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Готовность позже отгрузки")
    _log_date(db, order, "ship", order.ship_date, payload.ship_date, user.id, comment="заявка принята")
    _log_date(db, order, "ready", order.promised_ready, payload.ready_date, user.id, comment="заявка принята")
    order.ship_date = payload.ship_date
    order.promised_ready = payload.ready_date
    order.request_status = REQ_ACCEPTED
    order.request_comment = (payload.comment or "").strip() or None
    order.decided_by, order.decided_at = user.id, datetime.now(timezone.utc)
    from app.services import bitrix
    from app.services.weekly_plan import note_change, order_day

    bitrix.on_request_decided(db, order, accepted=True)
    note_change(db, order, None, order_day(order), ("СРОЧНЫЙ, " if order.priority == 2 else "") + "принята заявка", user.id)
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


class PromiseIn(BaseModel):
    ship_date: date | None = None
    ready_date: date | None = None
    reason: str | None = None
    comment: str | None = Field(default=None, max_length=500)
    ready_fact: date | None = None  # поправить фактическую готовность
    clear_ready_fact: bool = False


@router.post("/production-orders/{order_id}/promise", response_model=OrderOut)
def change_promise(
    order_id: int, payload: PromiseIn, db: Session = Depends(get_db), user: User = Depends(manage_orders)
) -> OrderOut:
    """Перенос обещанных дат (12.10): после приёма или запуска — только с
    причиной, каждое изменение в истории; запущенный заказ пересчитывает сроки."""
    order = _get_order(db, order_id)
    if order.status == ORDER_CLOSED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Заказ закрыт")
    committed = order.status == ORDER_RELEASED or order.request_status == REQ_ACCEPTED
    ship = payload.ship_date or order.ship_date
    ready = payload.ready_date if payload.ready_date is not None else order.promised_ready
    if ship and ready and ready > ship:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Готовность позже отгрузки")
    moved = (payload.ship_date and payload.ship_date != order.ship_date) or (
        payload.ready_date and payload.ready_date != order.promised_ready
    )
    if moved and committed:
        if payload.reason not in DATE_CHANGE_REASONS:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите причину переноса")
        if payload.reason == "other" and not (payload.comment or "").strip():
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Опишите причину в комментарии")
    from app.services.weekly_plan import note_change, order_day

    old_day = order_day(order)
    changes = []
    if payload.ship_date and payload.ship_date != order.ship_date:
        changes.append(("ship", order.ship_date, payload.ship_date))
    if payload.ready_date and payload.ready_date != order.promised_ready:
        changes.append(("ready", order.promised_ready, payload.ready_date))
    if payload.ship_date:
        _log_date(db, order, "ship", order.ship_date, payload.ship_date, user.id, payload.reason, payload.comment)
        order.ship_date = payload.ship_date
    if payload.ready_date:
        _log_date(db, order, "ready", order.promised_ready, payload.ready_date, user.id, payload.reason, payload.comment)
        order.promised_ready = payload.ready_date
    if payload.clear_ready_fact:
        order.ready_at = None
    elif payload.ready_fact:
        _log_date(db, order, "ready_fact", order.ready_at, payload.ready_fact, user.id, payload.reason, payload.comment)
        order.ready_at = payload.ready_fact
    db.flush()
    if moved and order.status == ORDER_RELEASED:
        schedule_order(db, order, user.id)
    if changes and committed:
        from app.services import bitrix

        note_change(db, order, old_day, order_day(order),
                    "перенос: " + ", ".join(f"{'готовность' if f == 'ready' else 'отгрузка'} {a:%d.%m}→{b:%d.%m}" if a and b else f for f, a, b in changes)
                    + (f" ({DATE_CHANGE_REASONS.get(payload.reason or '', '')})" if payload.reason else ""), user.id)

        bitrix.on_promise_changed(db, order, changes, DATE_CHANGE_REASONS.get(payload.reason or ""), payload.comment)
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


class TaskDateIn(BaseModel):
    task_id: int
    date: date


class PlanDatesIn(BaseModel):
    """Ручные сроки: этап (задание участка) — на дату; весь заказ — сдвиг на
    N рабочих дней. shift_next — следующие этапы сдвигаются за изменённым."""

    tasks: list[TaskDateIn] = []
    shift_days: int = 0
    shift_next: bool = True


@router.post("/production-orders/{order_id}/plan-dates", response_model=OrderOut)
def set_plan_dates(order_id: int, payload: PlanDatesIn, db: Session = Depends(get_db), user: User = Depends(manage_orders)) -> OrderOut:
    from app.services.planning import set_task_date, shift_order

    order = _get_order(db, order_id)
    if order.status == ORDER_DRAFT:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Черновик ещё не запущен — сроков нет; дата отгрузки задаётся в заказе")
    if payload.shift_days:
        shift_order(db, order, payload.shift_days)
    for td in payload.tasks:
        task = db.get(ProductionTask, td.task_id)
        if task is None or task.production_order_id != order.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Задание не из этого заказа")
        set_task_date(db, task, td.date, user.id, payload.shift_next)
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


class PrintTasksIn(BaseModel):
    task_ids: list[int] = Field(min_length=1)


@router.post("/production-tasks/print-data")
def tasks_print_data(payload: PrintTasksIn, db: Session = Depends(get_db), user: User = Depends(view_orders)) -> list[dict]:
    """Данные для пакетной печати заданий: лист на участок."""
    from app.services.task_print import print_sheets

    tasks = db.query(ProductionTask).filter(ProductionTask.id.in_(payload.task_ids)).all()
    from app.core.security import sees_all_areas

    if not sees_all_areas(user):
        tasks = [t for t in tasks if t.area == user.area]
    return print_sheets(db, tasks)


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


class LineReadyIn(BaseModel):
    qty: float = Field(gt=0)
    site_id: int | None = None


@router.post("/production-orders/{order_id}/lines/{line_id}/ready", response_model=OrderOut)
def line_ready(
    order_id: int, line_id: int, payload: LineReadyIn, db: Session = Depends(get_db), user: User = Depends(manage_orders)
) -> OrderOut:
    """Изделие без этапов (царговые, 16.10): «Готово» — приход на склад
    готовой продукции по строке заказа."""
    from app.services.production_orders import mark_line_ready

    order = _get_order(db, order_id)
    line = db.get(ProductionOrderLine, line_id)
    if line is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Строка не найдена")
    try:
        mark_line_ready(db, order, line, payload.qty, payload.site_id, user.id)
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
    type_id: int | None = None  # нет — тип строки по серии (16.10)
    name: str | None = None
    dry_run: bool = True
    # цвет из графика → выбранная позиция плёнки (сохраняется в привязку цвета)
    color_films: dict[str, int] = {}
    # счёт 1С целиком (07.10): номер счёта и отгрузка — на все строки без своих
    invoice_no: str | None = None
    ship_date: date | None = None
    ship_from: date | None = None
    ship_to: date | None = None


class ScheduleColorOut(BaseModel):
    color: str
    option: str | None
    film: str | None
    sku_id: int | None
    status: str
    rows: int


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
    type_name: str | None = None
    errors: list[str]
    notes: list[str] = []


class ScheduleImportOut(BaseModel):
    rows: list[ScheduleRowOut]
    parse_errors: list[str]
    colors: list[ScheduleColorOut] = []
    order: OrderOut | None


@router.post("/production-orders/from-schedule", response_model=ScheduleImportOut)
def order_from_schedule(
    payload: ScheduleImportIn, db: Session = Depends(get_db), user: User = Depends(edit_orders)
) -> ScheduleImportOut:
    """График запуска (вставлен из Excel) → черновик заказа: строка графика
    — позиция по типу (находится или создаётся с техкартой по правилам) и
    строка заказа. dry_run — только предпросмотр; с ошибками заказ не
    создаётся."""
    from app.services.schedule_import import import_types

    type_, others = import_types(db, payload.type_id)
    if type_ is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Тип не найден")
    colors: list = []
    rows, parse_errors, order = import_schedule(
        db, text=payload.text, type_=type_, order_name=payload.name, user_id=user.id, dry_run=payload.dry_run,
        color_films=payload.color_films, colors_out=colors, other_types=others,
        invoice_no=(payload.invoice_no or "").strip() or None,
        ship_date=payload.ship_date if _can_manage(user) else None,
    )
    if order is not None and (payload.ship_from or payload.ship_to):
        _window(payload.ship_from, payload.ship_to)
        order.ship_from, order.ship_to = payload.ship_from, payload.ship_to
    if order is not None and not _can_manage(user):
        # у продажника дата из графика — конец вилки, твёрдую ставит производство
        if order.ship_to is None:
            order.ship_to = order.ship_date
        order.ship_date = None
    colors_out = [ScheduleColorOut(**c.__dict__) for c in colors]
    if order is not None:
        db.commit()
        db.refresh(order)
    else:
        db.rollback()
    return ScheduleImportOut(
        rows=[ScheduleRowOut(**{k: getattr(r, k) for k in ScheduleRowOut.model_fields}) for r in rows],
        parse_errors=parse_errors,
        colors=colors_out,
        order=_order_out(db, order) if order is not None else None,
    )

