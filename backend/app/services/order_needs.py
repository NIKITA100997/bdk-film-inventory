"""Потребность по заказам (12.10, планирование, этап 2).

Для каждого открытого заказа — сколько плёнки (м²) и материалов ему ещё
нужно и к какому дню; склад раздаётся заказам по очереди («мягкий резерв»):
сначала запущенные, потом принятые заявки, потом отправленные, потом
черновики; внутри — срочные раньше, потом по дате готовности/отгрузки.
Что не досталось — дефицит; открытая заявка на закупку плёнки с датой
поставки закрывает его, если успевает к «нужно к».

Запущенный заказ — по его строкам заданий (остаток, день из плана);
заявка и черновик — запуск по-настоящему в точке сохранения и откат
(как «Проверить срок»): строки, сроки, материалы по составу.

Плёнка считается группой материал+цвет+толщина в м², как у снабженца
(«Остатки и резерв»): остаток — все не списанные рулоны и штрипсы."""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.customer_orders import CO_ACCEPTED, CO_SUBMITTED, CustomerOrder
from app.models.dictionaries import Color, Material, MaterialSku, Thickness
from app.models.finished_goods import FgMove
from app.models.items import Item
from app.models.production import PlanSlot, ProductionTask, ProductionTaskLineReport
from app.models.production_orders import ORDER_DRAFT, ORDER_RELEASED, ProductionOrder
from app.models.purchasing import PurchaseRequest
from app.models.units import MaterialUnit, UnitStatus
from app.services.production import calc_default_strip_width

GROUP_NAMES = {0: "запущен", 1: "принят", 2: "заявка", 3: "черновик"}


@dataclass
class NeedRow:
    kind: str  # film / material
    key: str  # film:m-c-t / item:id
    name: str
    unit: str
    need: float
    allocated: float = 0.0
    shortage: float = 0.0
    need_by: date | None = None
    incoming: float = 0.0  # закрыто ожидаемой поставкой
    incoming_date: date | None = None


@dataclass
class FgFree:
    item_id: int
    name: str
    need: float
    free: float  # на складе ГП без заказа


@dataclass
class OrderNeeds:
    order_id: int
    name: str
    group: str
    priority: int
    date: date | None
    rows: list[NeedRow] = field(default_factory=list)
    fg: list[FgFree] = field(default_factory=list)
    error: str | None = None
    customer_order_id: int | None = None  # строка — незапущенный остаток заказа клиента (order_id = его id)


def _open_orders(db: Session) -> list[tuple[int, ProductionOrder | CustomerOrder]]:
    """Очередь: запущенные → принятые (заказы клиентов без запуска и
    собранные из них черновики) → отправленные → прочие черновики с датой.
    У заказа клиента — только незапущенный остаток: запущенное считается в
    его заказе на производство."""
    from app.services.customer_orders import remaining_lines

    out: list[tuple[int, ProductionOrder | CustomerOrder]] = []
    for co in db.query(CustomerOrder).filter(CustomerOrder.status.in_([CO_ACCEPTED, CO_SUBMITTED])):
        if remaining_lines(db, co):
            out.append((1 if co.status == CO_ACCEPTED else 2, co))
    for o in db.query(ProductionOrder).filter(ProductionOrder.status.in_([ORDER_DRAFT, ORDER_RELEASED])):
        if o.status == ORDER_RELEASED:
            rank = 0
        elif o.request_status == "accepted" or any(ln.customer_order_line_id for ln in o.lines):
            rank = 1
        elif o.request_status == "submitted":
            rank = 2
        elif o.ship_date or o.promised_ready:
            rank = 3
        else:
            continue
        out.append((rank, o))
    far = date(2100, 1, 1)
    out.sort(key=lambda x: (x[0], -(x[1].priority or 0), x[1].promised_ready or x[1].ship_date or x[1].ship_to or far,
                            isinstance(x[1], CustomerOrder), x[1].id))
    return out


def _film_label(db: Session, m: int, c: int, t: int) -> str:
    mm, cc, tt = db.get(Material, m), db.get(Color, c), db.get(Thickness, t)
    return f"{mm.name if mm else '?'} {cc.name if cc else '?'} {float(tt.value_mm):g}" if mm and cc and tt else "?"


def _line_needs(db: Session, order: ProductionOrder, line_dates: dict[int, date]) -> dict[str, NeedRow]:
    """Плёнка и материалы по строкам заданий заказа (уже в сессии)."""
    from app.services.materials import demand_by_item

    rows: dict[str, NeedRow] = {}
    tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id, ProductionTask.is_active.is_(True)).all()
    lines = [ln for t in tasks for ln in t.lines if not ln.production_closed]
    if not lines:
        return rows
    good = dict(
        db.query(ProductionTaskLineReport.task_line_id, func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
        .filter(ProductionTaskLineReport.task_line_id.in_([ln.id for ln in lines]))
        .group_by(ProductionTaskLineReport.task_line_id)
    )
    task_day: dict[int, date] = {}
    for ln in lines:
        d = line_dates.get(ln.id)
        if d and (ln.task_id not in task_day or d < task_day[ln.task_id]):
            task_day[ln.task_id] = d
        if ln.material_id is None or not ln.length_m:
            continue
        left = max(0.0, float(ln.quantity_pieces) - float(good.get(ln.id, 0)))
        if left <= 0:
            continue
        width = float(ln.strip_width_mm) if ln.strip_width_mm is not None else calc_default_strip_width(ln.part_name, float(ln.width_mm))
        m2 = left * float(ln.length_m) * width / 1000
        key = f"film:{ln.material_id}-{ln.color_id}-{ln.thickness_id}"
        r = rows.get(key) or NeedRow(kind="film", key=key, name=_film_label(db, ln.material_id, ln.color_id, ln.thickness_id), unit="м²", need=0.0)
        r.need += m2
        if d and (r.need_by is None or d < r.need_by):
            r.need_by = d
        rows[key] = r
    task_ids = {t.id for t in tasks}
    for item_id, uses in demand_by_item(db).items():
        mine = [u for u in uses if u[0] in task_ids]
        if not mine:
            continue
        it = db.get(Item, item_id)
        key = f"item:{item_id}"
        r = rows.get(key) or NeedRow(kind="material", key=key, name=it.name if it else str(item_id), unit=((it.unit or (it.kind.unit if it.kind else None)) if it else None) or "шт", need=0.0)
        for task_id, _n, _o, qty in mine:
            r.need += qty
            d = task_day.get(task_id)
            if d and (r.need_by is None or d < r.need_by):
                r.need_by = d
        rows[key] = r
    return rows


def _released_dates(db: Session, order: ProductionOrder) -> dict[int, date]:
    ids = [ln.id for t in db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id) for ln in t.lines]
    if not ids:
        return {}
    return {lid: d for lid, d in db.query(PlanSlot.task_line_id, func.min(PlanSlot.date)).filter(PlanSlot.task_line_id.in_(ids)).group_by(PlanSlot.task_line_id)}


def _draft_needs(db: Session, order: ProductionOrder | CustomerOrder, user_id: int) -> tuple[dict[str, NeedRow], str | None]:
    """Запуск в точке сохранения → потребность → откат. Заказ клиента —
    пробный заказ на производство из его незапущенного остатка."""
    from app.services.customer_orders import transient_production_order
    from app.services.production_orders import OrderError
    from app.services.trial_release import trial_release

    sp = db.begin_nested()
    try:
        po = transient_production_order(db, order, user_id) if isinstance(order, CustomerOrder) else order
        if po is None:
            return {}, None
        trial = trial_release(db, po, user_id)
        return _line_needs(db, po, trial.dates), None
    except OrderError as e:
        return {}, str(e)
    finally:
        sp.rollback()


def compute(db: Session, user_id: int) -> list[OrderNeeds]:
    from app.services.materials import balances as material_balances

    film_stock: dict[str, float] = defaultdict(float)
    for m, c, t, area in (
        db.query(MaterialSku.material_id, MaterialSku.color_id, MaterialSku.thickness_id, func.sum(MaterialUnit.width_mm * MaterialUnit.length_m / 1000))
        .join(MaterialUnit, MaterialUnit.material_sku_id == MaterialSku.id)
        .filter(MaterialUnit.status != UnitStatus.SPISAN)
        .group_by(MaterialSku.material_id, MaterialSku.color_id, MaterialSku.thickness_id)
    ):
        film_stock[f"film:{m}-{c}-{t}"] = float(area or 0)
    incoming: dict[str, list[list]] = defaultdict(list)  # key → [[м², дата], …]
    for pr in db.query(PurchaseRequest).filter(PurchaseRequest.status == "open"):
        incoming[f"film:{pr.material_id}-{pr.color_id}-{pr.thickness_id}"].append([float(pr.requested_area_m2), pr.promised_delivery_date])
    for v in incoming.values():
        v.sort(key=lambda x: x[1] or date(2100, 1, 1))

    mat_stock: dict[int, float] = {}  # остаток материала, общий на все заказы
    result: list[OrderNeeds] = []
    for rank, order in _open_orders(db):
        is_co = isinstance(order, CustomerOrder)
        on = OrderNeeds(order_id=order.id, name=("Заказ клиента: " + order.name) if is_co else order.name, group=GROUP_NAMES[rank],
                        priority=order.priority or 0, date=order.promised_ready or order.ship_date or order.ship_to,
                        customer_order_id=order.id if is_co else None)
        if not is_co and order.status == ORDER_RELEASED:
            rows = _line_needs(db, order, _released_dates(db, order))
        else:
            rows, on.error = _draft_needs(db, order, user_id)
            # FG: готовые двери на складе без заказа — можно отдать вместо производства
            item_ids = {ln.item_id for ln in order.lines}
            free = dict(
                db.query(FgMove.item_id, func.sum(FgMove.qty))
                .filter(FgMove.item_id.in_(item_ids), FgMove.order_line_id.is_(None))
                .group_by(FgMove.item_id)
            ) if item_ids else {}
            for ln in order.lines:
                f = float(free.get(ln.item_id) or 0)
                if f > 0:
                    it = db.get(Item, ln.item_id)
                    on.fg.append(FgFree(item_id=ln.item_id, name=it.name if it else str(ln.item_id), need=float(ln.quantity), free=f))
        new_ids = [int(k.split(":")[1]) for k in rows if k.startswith("item:") and int(k.split(":")[1]) not in mat_stock]
        if new_ids:
            got = material_balances(db, new_ids)
            for iid in new_ids:
                mat_stock[iid] = float(got.get(iid, 0.0))
        for key, r in sorted(rows.items(), key=lambda kv: kv[1].need_by or date(2100, 1, 1)):
            if r.kind == "film":
                have = film_stock.get(key, 0.0)
            else:
                iid = int(key.split(":")[1])
                have = float(mat_stock.get(iid, 0.0))
            r.need = round(r.need, 3)
            r.allocated = round(min(r.need, max(0.0, have)), 3)
            if r.kind == "film":
                film_stock[key] = have - r.allocated
            else:
                mat_stock[iid] = have - r.allocated
            short = r.need - r.allocated
            # ожидаемая поставка плёнки, если успевает к «нужно к»
            for lot in incoming.get(key, []):
                if short <= 0.001 or lot[0] <= 0:
                    continue
                if lot[1] is None or r.need_by is None or lot[1] <= r.need_by:
                    take = min(short, lot[0])
                    lot[0] -= take
                    short -= take
                    r.incoming = round(r.incoming + take, 3)
                    r.incoming_date = lot[1]
            r.shortage = round(max(0.0, short), 3)
            on.rows.append(r)
        result.append(on)
    return result


@dataclass
class ShortageSummary:
    kind: str
    key: str
    name: str
    unit: str
    shortage: float
    need_by: date | None
    orders: list[dict]


def summary(needs: list[OrderNeeds]) -> list[ShortageSummary]:
    agg: dict[str, ShortageSummary] = {}
    for on in needs:
        for r in on.rows:
            if r.shortage <= 0.001:
                continue
            s = agg.get(r.key) or ShortageSummary(kind=r.kind, key=r.key, name=r.name, unit=r.unit, shortage=0.0, need_by=None, orders=[])
            s.shortage = round(s.shortage + r.shortage, 3)
            if r.need_by and (s.need_by is None or r.need_by < s.need_by):
                s.need_by = r.need_by
            s.orders.append({"order_id": on.order_id, "customer_order_id": on.customer_order_id, "name": on.name, "group": on.group, "shortage": r.shortage,
                             "need_by": r.need_by.isoformat() if r.need_by else None})
            agg[r.key] = s
    return sorted(agg.values(), key=lambda s: (s.need_by or date(2100, 1, 1), s.name))
