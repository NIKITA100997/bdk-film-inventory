"""Монитор производства (08.10.2026) — как Excel «Монитор … запуск»: по всем
открытым заданиям участкам сразу — план, сделано, брак, остаток. Отдаёт
плоский список строк заданий; сводки «по участкам», «заказы × участки» и
лист участка собирает экран (одни и те же строки, разные срезы)."""

from collections import defaultdict
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import Color, Material, Part, Thickness
from app.models.items import Item, ItemType
from app.models.production import PlanSlot, ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.production_orders import ORDER_RELEASED, ProductionOrder, ProductionOrderLine
from app.models.sites import Site
from app.services.door_cols import door_cols
from app.services.item_attrs import effective_direction

router = APIRouter(prefix="/production-monitor", tags=["production-monitor"])
view = require_permission("production_tasks.manage", "production_tasks.view", "production_tasks.report", "reports.view")


class MonitorArea(BaseModel):
    code: str
    name: str
    site: str | None
    sort: int
    per_day: float | None  # мощность участка в день (если задана) — сколько дней на остаток


class MonitorOrder(BaseModel):
    id: int
    name: str
    ship_date: date | None
    kind: str


class MonitorRow(BaseModel):
    task_line_id: int
    task_id: int
    area: str
    order_id: int | None  # пусто — задание цеха без заказа
    invoice_no: str | None
    position: str
    direction: str | None
    film: str | None
    program: str | None
    plan: float
    good: float
    defect: float
    closed: bool  # мастер закрыл строку («всё сделано»)
    last_report: datetime | None
    date_from: date | None
    date_to: date | None
    group: str | None = None  # группа участка (08.10, services/line_groups.py)
    # строка заказа (13.10): раскрытие заказа по строкам с участками
    order_line_id: int | None = None
    line_qty: float | None = None
    series: str = ""
    size: str = ""
    color: str = ""
    source: str = ""
    # выдача плёнки (16.10, как на доске выдачи): issued / covered — есть,
    # partial — частично, none — не выдана, site_stock — со склада Фабрики
    film_status: str | None = None
    film_need_m: float | None = None
    film_to_issue_m: float | None = None
    # монитор по заказам (21.10): операция маршрута и её порядок — столбцы;
    # деталь п/ф (part_id) или сама позиция заказа; быстрый отчёт из монитора —
    # участок без рулона и дневного плана, строка без плёнки и открыта
    operation: str | None = None
    op_seq: int | None = None
    part_id: int | None = None
    task_name: str | None = None
    quick: bool = False
    launch_date: date | None = None


class MonitorOut(BaseModel):
    areas: list[MonitorArea]
    orders: list[MonitorOrder]
    rows: list[MonitorRow]


@router.get("", response_model=MonitorOut, dependencies=[Depends(view)])
def production_monitor(include_done: bool = False, db: Session = Depends(get_db)) -> MonitorOut:
    # include_done (20.10): и задания, закрытые целиком, — по запущенным
    # заказам и по заказам с отгрузкой за последние 30 дней; без заказа —
    # созданные за 30 дней. Иначе готовая строка пропадала из монитора.
    q = db.query(ProductionTaskLine, ProductionTask).join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
    if include_done:
        since = date.today() - timedelta(days=30)
        recent = (
            db.query(ProductionOrder.id)
            .filter(or_(ProductionOrder.status == ORDER_RELEASED, ProductionOrder.ship_date >= since))
        )
        q = q.filter(
            or_(
                ProductionTask.is_active.is_(True),
                ProductionTask.production_order_id.in_(recent),
                (ProductionTask.production_order_id.is_(None)) & (ProductionTask.created_at >= since),
            )
        )
    else:
        q = q.filter(ProductionTask.is_active.is_(True))
    lines = q.all()
    ids = [ln.id for ln, _ in lines]
    agg: dict[int, tuple[float, float, datetime | None]] = {}
    slots: dict[int, list[date]] = defaultdict(list)
    if ids:
        for lid, g, d, last in (
            db.query(
                ProductionTaskLineReport.task_line_id,
                func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
                func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0),
                func.max(ProductionTaskLineReport.reported_at),
            )
            .filter(ProductionTaskLineReport.task_line_id.in_(ids), ProductionTaskLineReport.counts_toward_line.is_(True))
            .group_by(ProductionTaskLineReport.task_line_id)
        ):
            agg[lid] = (float(g), float(d), last)
        for s in db.query(PlanSlot.task_line_id, PlanSlot.date).filter(PlanSlot.task_line_id.in_(ids)):
            slots[s.task_line_id].append(s.date)

    order_lines = {
        ol.id: ol
        for ol in db.query(ProductionOrderLine).filter(
            ProductionOrderLine.id.in_({ln.order_line_id for ln, _ in lines if ln.order_line_id})
        )
    }
    parts = {p.id: p for p in db.query(Part).filter(Part.id.in_({ln.part_id for ln, _ in lines if ln.part_id}))}
    item_ids = {ol.item_id for ol in order_lines.values()} | {p.item_id for p in parts.values() if p.item_id}
    items = {i.id: i for i in db.query(Item).filter(Item.id.in_(item_ids))} if item_ids else {}
    types = {t.id: t for t in db.query(ItemType)}
    mats = {m.id: m.name for m in db.query(Material)}
    cols = {c.id: c.name for c in db.query(Color)}
    ths = {t.id: float(t.value_mm) for t in db.query(Thickness)}

    def direction(item_id: int | None) -> str | None:
        item = items.get(item_id) if item_id else None
        return effective_direction(item, types.get(item.type_id)) if item else None

    from app.models.dictionaries import PartStage

    area_by_code = {a.code: a for a in db.query(Area)}
    stage_ids = {ln.part_stage_id for ln, _ in lines if ln.part_stage_id}
    stages = {st.id: st for st in db.query(PartStage).filter(PartStage.id.in_(stage_ids or {-1}))}
    launched = {
        o.id: (o.released_at.date() if o.released_at else None)
        for o in db.query(ProductionOrder).filter(ProductionOrder.id.in_({t.production_order_id for _, t in lines if t.production_order_id} or {-1}))
    }
    rows: list[MonitorRow] = []
    order_ids: set[int] = set()
    area_codes: set[str] = set()
    for ln, t in lines:
        ol = order_lines.get(ln.order_line_id) if ln.order_line_id else None
        part = parts.get(ln.part_id) if ln.part_id else None
        position = ln.part_name or (items[ol.item_id].name if ol and ol.item_id in items else "") or (part.name if part else "")
        film = None
        if ln.material_id:
            film = f"{mats.get(ln.material_id, '')} {cols.get(ln.color_id, '')} {ths.get(ln.thickness_id, 0):g}".strip()
        from app.services.line_groups import line_group
        from app.services.type_rules import item_chars_cached

        grp = line_group(db, ln, t.area, [] if ln.part_id else (item_chars_cached(db, ol.item_id) if ol else []))
        g, d, last = agg.get(ln.id, (0.0, 0.0, None))
        days = sorted(slots.get(ln.id, []))
        dc = door_cols(item_chars_cached(db, ol.item_id), ol.source_text, items[ol.item_id].name if ol.item_id in items else None) if ol else {}
        rows.append(
            MonitorRow(
                task_line_id=ln.id, task_id=t.id, area=t.area, order_id=t.production_order_id,
                invoice_no=ol.invoice_no if ol else None, position=position,
                direction=direction(ol.item_id if ol else (part.item_id if part else None)),
                film=film, program=ln.program, plan=float(ln.quantity_pieces), good=g, defect=d,
                closed=bool(ln.production_closed), last_report=last,
                date_from=days[0] if days else None, date_to=days[-1] if days else None,
                group=grp[1] if grp else None,
                order_line_id=ol.id if ol else None, line_qty=float(ol.quantity) if ol else None,
                series=dc.get("series", ""), size=dc.get("size", ""), color=dc.get("color", ""), source=dc.get("source", ""),
                operation=(stages[ln.part_stage_id].name if ln.part_stage_id in stages else None) or (area_by_code[t.area].name if t.area in area_by_code else None),
                op_seq=stages[ln.part_stage_id].sequence_order if ln.part_stage_id in stages else None,
                part_id=ln.part_id, task_name=t.name,
                quick=bool(
                    t.is_active and not ln.is_closed and ln.material_id is None and t.area in area_by_code
                    and not area_by_code[t.area].requires_daily_plan and not area_by_code[t.area].requires_roll_on_report
                ),
                launch_date=launched.get(t.production_order_id) if t.production_order_id else None,
            )
        )
        area_codes.add(t.area)
        if t.production_order_id:
            order_ids.add(t.production_order_id)

    # выдача плёнки по строкам с плёнкой — та же логика, что у доски выдачи
    film_tasks = {t.id: t for ln, t in lines if ln.material_id is not None and not ln.is_closed}
    if film_tasks:
        from app.api.film_issue import film_line_states

        area_site = {a.code: a.site_id for a in db.query(Area)}
        site_names = {s.id: s.name for s in db.query(Site)}
        by_line = {r.task_line_id: r for r in rows}
        for _t, _out, ln, _lo, fs in film_line_states(db, list(film_tasks.values()), lambda code: site_names.get(area_site.get(code))):
            r = by_line.get(ln.id)
            if r is not None:
                r.film_status, r.film_need_m, r.film_to_issue_m = fs.status, fs.need_m, fs.to_issue_m

    # порядок участков — по ходу работ: планировщик ставит сроки назад от
    # отгрузки, так что раньше по плану = раньше по маршруту
    starts: dict[str, list[int]] = defaultdict(list)
    for r in rows:
        if r.date_from:
            starts[r.area].append(r.date_from.toordinal())
    sites = {s.id: s.name for s in db.query(Site)}
    found = db.query(Area).filter(Area.code.in_(area_codes)).all() if area_codes else []
    found.sort(key=lambda a: (sum(starts[a.code]) / len(starts[a.code]) if starts[a.code] else 10**9, a.name))
    from app.services.areas import area_capacities

    caps = area_capacities(db)
    areas = [
        MonitorArea(
            code=a.code, name=a.name, site=sites.get(a.site_id) if a.site_id else None, sort=i,
            per_day=caps.get(a.code),
        )
        for i, a in enumerate(found)
    ]
    orders = [
        MonitorOrder(id=o.id, name=o.name, ship_date=o.ship_date, kind=o.kind)
        for o in db.query(ProductionOrder).filter(ProductionOrder.id.in_(order_ids)).order_by(ProductionOrder.ship_date, ProductionOrder.id)
    ] if order_ids else []
    return MonitorOut(areas=areas, orders=orders, rows=rows)
