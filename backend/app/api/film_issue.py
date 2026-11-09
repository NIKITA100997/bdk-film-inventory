"""Доска выдачи плёнки (15.10).

По заданиям с плёнкой: что нужно, что выдано, что покрыто остатком рулонов
на участке (рулон участка общий для его заданий — в т.ч. остатки прошлых
заданий, которые не сдали), что ещё выдать и к какому дню. Отдельно — что
лежит на участках; для Фабрики — сколько есть на её складе и сколько
переместить с Северного (режут и выдают на Северном, на Фабрику собирают
и перемещают). Расчёт нехватки — тот же, что у «Выдачи участку»
(api/production._task_out), без второй копии логики. Видят кладовщик и
начальник цеха."""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from types import SimpleNamespace

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload, selectinload

from app.api.production import (
    _area_roll_pool,
    _can_see_all_areas,
    _line_effective_strip_width,
    _line_issued_units_map,
    _line_report_aggregates,
    _preload_issued_unit_remaining,
    begin_read_cache,
)
from app.core.security import require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import Color, Material, Thickness
from app.models.events import EventType, MaterialEvent
from app.models.production import PlanSlot, ProductionLine, ProductionTask, ProductionTaskLine, ProductModel
from app.models.production_orders import ProductionOrder
from app.models.sites import Site
from app.models.storage import Rack
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.services.areas import cuts_film_on_site
from app.services.production import GroupShortfallLine, compute_remaining_length_m, compute_remaining_pieces, distribute_group_shortfall
from app.services.width_analogs import equivalent_widths

router = APIRouter(prefix="/film-issue", tags=["film-issue"])
view = require_permission("units.issue", "production_tasks.manage", "production_tasks.view")


class FilmIssueLineOut(BaseModel):
    task_id: int
    task_name: str
    order_name: str | None
    line_id: int
    part_name: str | None
    film: str
    spec_key: str
    strip_width_mm: float
    quantity_pieces: float
    produced_pieces: float
    need_m: float  # (план + брак) × длина детали
    issued_m: float  # выдано под эту строку
    covered_by_area_m: float  # покрыто рулонами, что уже лежат на участке
    to_issue_m: float  # ещё выдать
    to_issue_m2: float
    reserved_m: float  # закреплено на складе под строку (резерв под заказ), метров штрипса
    need_by: date | None  # первый день плана по строке
    status: str  # issued — выдано; covered — покрыто остатком участка; partial — частично; none — не выдано; site_stock — со склада площадки (Фабрика)


class FilmIssueAreaOut(BaseModel):
    area: str
    area_name: str
    site: str | None
    lines: list[FilmIssueLineOut]


class AreaRollOut(BaseModel):
    unit_id: int
    area: str
    area_name: str
    film: str
    spec_key: str
    width_mm: float
    remaining_m: float
    remaining_m2: float
    is_strip: bool
    issued_at: datetime | None
    task_name: str | None
    leftover: bool  # с прошлого (закрытого) задания или выдан без задания


class SiteStockOut(BaseModel):
    spec_key: str
    film: str
    need_m2: float  # ещё выдать участкам Фабрики
    free_stock_m2: float  # свободный остаток склада Фабрики
    to_transfer_m2: float  # переместить с Северного


class FilmIssueBoardOut(BaseModel):
    areas: list[FilmIssueAreaOut]
    rolls_on_areas: list[AreaRollOut]
    fabrika: list[SiteStockOut]
    reserve_enabled: bool


class FilmIssueQueueAssignmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    line_id: int
    line_name: str
    date: date
    employee_names: str
    quantity_pieces: float


class FilmIssueQueueUnitOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    width_mm: float
    length_m: float
    material_sku_id: int
    parent_id: int | None
    is_strip: bool
    status: str
    remaining_length_m: float
    area: str | None


class FilmIssueQueueLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    material: str | None
    color: str | None
    thickness: float | None
    quantity_pieces: float
    width_mm: float
    length_m: float
    strip_width_mm: float
    part_name: str | None
    is_closed: bool
    use_illiquid: bool
    produced_good_pieces: float
    defect_pieces: float
    remaining_pieces: float
    remaining_length_m: float
    shortfall_length_m: float
    issued_length_m: float
    issued_units: list[FilmIssueQueueUnitOut] = []
    assignments: list[FilmIssueQueueAssignmentOut] = []


class FilmIssueQueueTaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    product_model_name: str | None
    name: str | None
    area: str
    is_active: bool
    production_order_name: str | None
    lines: list[FilmIssueQueueLineOut] = []


@dataclass
class FilmLineState:
    need_m: float  # (план + брак) × длина детали
    issued_m: float  # выдано под строку
    covered_m: float  # покрыто рулонами на участке
    to_issue_m: float  # ещё выдать
    strip_width_mm: float
    status: str  # issued / covered / partial / none / site_stock


def _area_shortfalls(db: Session, area: str, pool: dict) -> dict[int, float]:
    """Нехватка по строкам участка одним расчётом, как в _task_out.

    В старом варианте этот общий расчёт запускался заново для каждого
    задания на экране. Здесь один раз обходим пул участка и распределяем
    общий остаток по тем же группам плёнка+аналог ширины.
    """
    any_width = cuts_film_on_site(db, area)
    width_keys: dict[float, float] = {}

    def width_key(line: ProductionTaskLine) -> float:
        width = _line_effective_strip_width(line)
        if any_width:
            return 0.0
        if width not in width_keys:
            width_keys[width] = min(equivalent_widths(db, width))
        return width_keys[width]

    reports = pool["reports"]
    issued = pool["issued"]
    lines_by_id = {line.id: line for line in pool["active_lines"]}
    by_spec: dict[tuple[int | None, int | None, int | None], dict[int, GroupShortfallLine]] = {}
    for line in lines_by_id.values():
        _good, defect = reports.get(line.id, (0.0, 0.0))
        by_spec.setdefault((line.material_id, line.color_id, line.thickness_id), {})[line.id] = GroupShortfallLine(
            line_id=line.id,
            width_key=width_key(line),
            needed_length_m=(float(line.quantity_pieces) + defect) * float(line.length_m),
            issued_length_m=issued.get(line.id, 0.0),
            is_closed=line.is_closed,
        )

    for _unit, source_line, source_active, remaining in pool["units"]:
        if source_active or source_line.id in lines_by_id:
            continue
        group = by_spec.setdefault(
            (source_line.material_id, source_line.color_id, source_line.thickness_id), {}
        )
        previous = group.get(source_line.id)
        group[source_line.id] = GroupShortfallLine(
            line_id=source_line.id,
            width_key=width_key(source_line),
            needed_length_m=0.0,
            issued_length_m=(previous.issued_length_m if previous else 0.0) + remaining,
            is_closed=True,
        )

    result: dict[int, float] = {}
    for group in by_spec.values():
        result.update(distribute_group_shortfall(list(group.values())))
    return result


def film_line_states(
    db: Session,
    tasks: list[ProductionTask],
    site_of,
    include_closed: bool = False,
    include_assignments: bool = False,
):
    """Быстрый общий расчёт для выдачи плёнки и монитора.

    Возвращает только данные, которые нужны этим экранам. Раньше здесь
    вызывался полный _task_out для каждого задания: он строил карточки,
    предупреждения, назначаемые рулоны и несколько наборов агрегатов,
    хотя доске выдачи нужна лишь короткая сводка.
    """
    begin_read_cache(db)
    task_lines = [
        line for task in tasks for line in task.lines if line.material_id is not None
    ]
    line_ids = [line.id for line in task_lines]
    reports = _line_report_aggregates(db, line_ids)
    from app.api.production import _issued_length_by_task_line

    issued = _issued_length_by_task_line(db, line_ids)
    units_by_line = _line_issued_units_map(db, line_ids)
    all_units = [unit for units in units_by_line.values() for unit in units]
    remaining_by_unit = _preload_issued_unit_remaining(db, all_units)

    pool_by_area: dict[str, dict] = {}
    shortfalls_by_area: dict[str, dict[int, float]] = {}
    for task in tasks:
        if task.area not in pool_by_area:
            pool = _area_roll_pool(db, task.area)
            pool_by_area[task.area] = pool
            shortfalls_by_area[task.area] = _area_shortfalls(db, task.area, pool)

    model_ids = {task.product_model_id for task in tasks if task.product_model_id is not None}
    order_ids = {task.production_order_id for task in tasks if task.production_order_id is not None}
    model_names = {
        model.id: model.name for model in db.query(ProductModel).filter(ProductModel.id.in_(model_ids)).all()
    } if model_ids else {}
    order_names = {
        order.id: order.name for order in db.query(ProductionOrder).filter(ProductionOrder.id.in_(order_ids)).all()
    } if order_ids else {}

    assignment_line_ids = {
        assignment.line_id
        for task in tasks
        for line in task.lines
        for assignment in line.assignments
    } if include_assignments else set()
    assignment_line_names = {
        line.id: line.name
        for line in db.query(ProductionLine).filter(ProductionLine.id.in_(assignment_line_ids)).all()
    } if assignment_line_ids else {}

    site_cache: dict[str, str | None] = {}
    for task in tasks:
        from_site_stock = site_cache.setdefault(task.area, site_of(task.area)) == "Фабрика"
        task_out = SimpleNamespace(
            name=task.name,
            product_model_name=model_names.get(task.product_model_id),
            production_order_name=order_names.get(task.production_order_id),
        )
        for line in task.lines:
            if line.material_id is None or (line.is_closed and not include_closed):
                continue
            good, defect = reports.get(line.id, (0.0, 0.0))
            issued_length = round(float(issued.get(line.id, 0.0)), 2)
            shortfall = round(float(shortfalls_by_area[task.area].get(line.id, 0.0)), 2)
            remaining_pieces = compute_remaining_pieces(float(line.quantity_pieces), good)
            remaining_length = compute_remaining_length_m(float(line.length_m), remaining_pieces)
            strip_width = _line_effective_strip_width(line)
            need = round((float(line.quantity_pieces) + defect) * float(line.length_m), 2)
            covered = round(max(0.0, need - issued_length - shortfall), 2)
            to_issue = shortfall
            if from_site_stock:
                to_issue, covered, status = round(remaining_length, 2), 0.0, "site_stock"
            elif to_issue <= 0.01:
                status = "issued" if issued_length >= need - 0.01 else "covered"
            else:
                status = "partial" if issued_length > 0 or covered > 0 else "none"

            issued_units = [
                SimpleNamespace(
                    id=unit.id,
                    width_mm=float(unit.width_mm),
                    length_m=float(unit.length_m),
                    material_sku_id=unit.material_sku_id,
                    parent_id=unit.parent_id,
                    is_strip=bool(unit.is_strip),
                    status=unit.status.value if hasattr(unit.status, "value") else str(unit.status),
                    remaining_length_m=remaining_by_unit.get(unit.id, float(unit.length_m)),
                    area=unit.area,
                )
                for unit in units_by_line.get(line.id, [])
            ]
            assignments = [
                SimpleNamespace(
                    id=assignment.id,
                    line_id=assignment.line_id,
                    line_name=assignment_line_names.get(assignment.line_id, "—"),
                    date=assignment.date,
                    employee_names=assignment.employee_names,
                    quantity_pieces=float(assignment.quantity_pieces),
                )
                for assignment in line.assignments
            ] if include_assignments else []
            line_out = SimpleNamespace(
                id=line.id,
                strip_width_mm=strip_width,
                produced_good_pieces=good,
                defect_pieces=defect,
                remaining_pieces=remaining_pieces,
                remaining_length_m=remaining_length,
                shortfall_length_m=shortfall,
                issued_length_m=issued_length,
                issued_units=issued_units,
                assignments=assignments,
            )
            yield task, task_out, line, line_out, FilmLineState(
                need, issued_length, covered, round(to_issue, 2), strip_width, status
            )


@router.get("/mobile-queue", response_model=list[FilmIssueQueueTaskOut])
def film_issue_mobile_queue(
    db: Session = Depends(get_db), user: User = Depends(view)
) -> list[FilmIssueQueueTaskOut]:
    """Компактная очередь для планшетной выдачи.

    Экрану не нужны полные карточки заданий с предупреждениями, данными
    п/ф и расчётами мастера. Загружаются только активные задания, строки
    с плёнкой и поля, которые показывает или использует склад.
    """
    task_options = [
        joinedload(ProductionTask.product_model),
        selectinload(
            ProductionTask.lines.and_(ProductionTaskLine.material_id.isnot(None))
        ).selectinload(ProductionTaskLine.assignments),
    ]
    query = (
        db.query(ProductionTask)
        .options(*task_options)
        .filter(
            ProductionTask.is_active.is_(True),
            ProductionTask.lines.any(ProductionTaskLine.material_id.isnot(None)),
        )
    )
    if not _can_see_all_areas(user):
        query = query.filter(ProductionTask.area == user.area)
    tasks = [task for task in query.order_by(ProductionTask.created_at.desc()).all() if task.lines]
    if not tasks:
        return []

    material_ids = {line.material_id for task in tasks for line in task.lines if line.material_id is not None}
    color_ids = {line.color_id for task in tasks for line in task.lines if line.color_id is not None}
    thickness_ids = {line.thickness_id for task in tasks for line in task.lines if line.thickness_id is not None}
    materials = {row.id: row.name for row in db.query(Material).filter(Material.id.in_(material_ids)).all()} if material_ids else {}
    colors = {row.id: row.name for row in db.query(Color).filter(Color.id.in_(color_ids)).all()} if color_ids else {}
    thicknesses = {
        row.id: float(row.value_mm) for row in db.query(Thickness).filter(Thickness.id.in_(thickness_ids)).all()
    } if thickness_ids else {}
    order_ids = {task.production_order_id for task in tasks if task.production_order_id is not None}
    order_names = {
        row.id: row.name for row in db.query(ProductionOrder).filter(ProductionOrder.id.in_(order_ids)).all()
    } if order_ids else {}
    site_by_area = dict(
        db.query(Area.code, Site.name)
        .join(Site, Area.site_id == Site.id)
        .filter(Area.code.in_({task.area for task in tasks}))
        .all()
    )

    output = {
        task.id: FilmIssueQueueTaskOut(
            id=task.id,
            product_model_name=task.product_model.name if task.product_model is not None else None,
            name=task.name,
            area=task.area,
            is_active=task.is_active,
            production_order_name=order_names.get(task.production_order_id),
            lines=[],
        )
        for task in tasks
    }

    for task, _task_out, line, line_out, _state in film_line_states(
        db, tasks, lambda area: site_by_area.get(area), include_closed=True, include_assignments=True
    ):
        output[task.id].lines.append(
            FilmIssueQueueLineOut(
                id=line.id,
                material=materials.get(line.material_id),
                color=colors.get(line.color_id),
                thickness=thicknesses.get(line.thickness_id),
                quantity_pieces=float(line.quantity_pieces),
                width_mm=float(line.width_mm),
                length_m=float(line.length_m),
                strip_width_mm=float(line_out.strip_width_mm),
                part_name=line.part_name,
                is_closed=bool(line.is_closed),
                use_illiquid=bool(line.use_illiquid),
                produced_good_pieces=float(line_out.produced_good_pieces),
                defect_pieces=float(line_out.defect_pieces),
                remaining_pieces=float(line_out.remaining_pieces),
                remaining_length_m=float(line_out.remaining_length_m),
                shortfall_length_m=float(line_out.shortfall_length_m),
                issued_length_m=float(line_out.issued_length_m),
                issued_units=[
                    FilmIssueQueueUnitOut(**vars(u)) if isinstance(u, SimpleNamespace) else u
                    for u in line_out.issued_units
                ],
                assignments=[
                    FilmIssueQueueAssignmentOut(**vars(a)) if isinstance(a, SimpleNamespace) else a
                    for a in line_out.assignments
                ],
            )
        )
    return list(output.values())


@router.get("/board", response_model=FilmIssueBoardOut)
def film_issue_board(db: Session = Depends(get_db), user: User = Depends(view)) -> FilmIssueBoardOut:
    from app.services.area_supply import serves_all_areas

    all_areas = _can_see_all_areas(user) or serves_all_areas(db, user)
    areas = {a.code: a for a in db.query(Area)}
    sites = {s.id: s for s in db.query(Site)}

    def site_of(code: str) -> str | None:
        a = areas.get(code)
        return sites[a.site_id].name if a is not None and a.site_id in sites else None

    names: dict[tuple, str] = {}

    def film(m: int, c: int, t: int) -> str:
        if (m, c, t) not in names:
            names[(m, c, t)] = f"{db.get(Material, m).name} {db.get(Color, c).name} {float(db.get(Thickness, t).value_mm):g} мм"
        return names[(m, c, t)]

    tasks = [
        t for t in db.query(ProductionTask).options(joinedload(ProductionTask.lines)).filter(ProductionTask.is_active.is_(True))
        if any(l.material_id is not None and not l.is_closed for l in t.lines)
    ]
    if not all_areas:
        tasks = [t for t in tasks if t.area == user.area]
    line_ids = [l.id for t in tasks for l in t.lines]
    first_slot = dict(
        db.query(PlanSlot.task_line_id, func.min(PlanSlot.date)).filter(PlanSlot.task_line_id.in_(line_ids or [-1])).group_by(PlanSlot.task_line_id)
    )

    from app.models.film_reserve import RES_ACTIVE, FilmReservation
    from app.services import film_reserve

    reserved_m2: dict[int, float] = defaultdict(float)
    for lid, a in db.query(FilmReservation.task_line_id, FilmReservation.area_m2).filter(
        FilmReservation.status == RES_ACTIVE, FilmReservation.task_line_id.in_(line_ids or [-1])
    ):
        reserved_m2[lid] += float(a)

    reserve_on = film_reserve.enabled(db)
    by_area: dict[str, list[FilmIssueLineOut]] = defaultdict(list)
    for t, out, l, lo, fs in film_line_states(db, tasks, site_of):
        need, issued, covered, to_issue, sw, status = fs.need_m, fs.issued_m, fs.covered_m, fs.to_issue_m, fs.strip_width_mm, fs.status
        by_area[t.area].append(FilmIssueLineOut(
            task_id=t.id, task_name=out.name or out.product_model_name or f"Задание №{t.id}", order_name=out.production_order_name,
            line_id=l.id, part_name=l.part_name, film=film(l.material_id, l.color_id, l.thickness_id),
            spec_key=f"{l.material_id}-{l.color_id}-{l.thickness_id}", strip_width_mm=sw,
            quantity_pieces=float(l.quantity_pieces), produced_pieces=float(lo.produced_good_pieces),
            need_m=need, issued_m=issued, covered_by_area_m=covered, to_issue_m=to_issue,
            to_issue_m2=round(to_issue * sw / 1000, 3), reserved_m=round(reserved_m2.get(l.id, 0.0) * 1000 / sw, 2), need_by=first_slot.get(l.id), status=status,
        ))
    area_rows = sorted(
        (
            FilmIssueAreaOut(area=code, area_name=areas[code].name if code in areas else code, site=site_of(code),
                             lines=sorted(rows, key=lambda r: (r.need_by or date(2100, 1, 1), r.task_id, r.line_id)))
            for code, rows in by_area.items()
        ),
        key=lambda a: (a.site or "", a.area_name),
    )

    # рулоны на участках, в т.ч. остатки прошлых заданий, которые не сдали
    rolls: list[AreaRollOut] = []
    area_units = db.query(MaterialUnit).filter(
        MaterialUnit.status == UnitStatus.VYDAN_UCHASTKU, MaterialUnit.area.isnot(None)
    )
    if not all_areas:
        area_units = area_units.filter(MaterialUnit.area == user.area)
    area_units = area_units.all()
    remaining_by_unit = _preload_issued_unit_remaining(db, area_units)
    issued_at = dict(
        db.query(MaterialEvent.unit_id, func.max(MaterialEvent.timestamp))
        .filter(
            MaterialEvent.event_type == EventType.VYDACHA_UCHASTKU,
            MaterialEvent.unit_id.in_([u.id for u in area_units] or [-1]),
        )
        .group_by(MaterialEvent.unit_id)
    )
    for u in area_units:
        sku = u.material_sku
        line = db.get(ProductionTaskLine, u.production_task_line_id) if u.production_task_line_id else None
        rem = remaining_by_unit[u.id]
        rolls.append(AreaRollOut(
            unit_id=u.id, area=u.area, area_name=areas[u.area].name if u.area in areas else u.area,
            film=film(sku.material_id, sku.color_id, sku.thickness_id), spec_key=f"{sku.material_id}-{sku.color_id}-{sku.thickness_id}",
            width_mm=float(u.width_mm), remaining_m=rem, remaining_m2=round(rem * float(u.width_mm) / 1000, 3), is_strip=bool(u.is_strip),
            issued_at=issued_at.get(u.id), task_name=(line.task.name or f"Задание №{line.task.id}") if line is not None else None,
            leftover=line is None or line.is_closed or not line.task.is_active,
        ))
    rolls.sort(key=lambda r: (r.area_name, r.film, -r.remaining_m))

    # Фабрика: что ещё выдать её участкам против свободного остатка её склада
    fabrika: list[SiteStockOut] = []
    fab = next((s for s in sites.values() if s.name == "Фабрика"), None)
    if fab is not None:
        need_m2: dict[str, float] = defaultdict(float)
        labels: dict[str, str] = {}
        for a in area_rows:
            if a.site == fab.name:
                for r in a.lines:
                    need_m2[r.spec_key] += r.to_issue_m2
                    labels[r.spec_key] = r.film
        need_m2 = {k: v for k, v in need_m2.items() if v > 0.001}
        free: dict[str, float] = defaultdict(float)
        racks = [code for (code,) in db.query(Rack.code).filter(Rack.warehouse_id == fab.warehouse_id)]
        if racks and need_m2:
            q = db.query(MaterialUnit).filter(
                MaterialUnit.status == UnitStatus.NA_KHRANENII, MaterialUnit.production_task_line_id.is_(None),
                MaterialUnit.marked_illiquid.is_(False),  # неликвид не свободен под обычные строки (23.10)
                or_(*[MaterialUnit.location_code.like(f"{c}-%") for c in racks]),
            )
            for u in q:
                sku = u.material_sku
                # закреплённое под заказ — не свободно (резерв, 15.10)
                left_m = float(u.length_m) - (film_reserve.reserved_m(db, u.id) if reserve_on else 0.0)
                free[f"{sku.material_id}-{sku.color_id}-{sku.thickness_id}"] += float(u.width_mm) * max(0.0, left_m) / 1000
        fabrika = sorted(
            (
                SiteStockOut(spec_key=k, film=labels[k], need_m2=round(v, 2), free_stock_m2=round(free.get(k, 0.0), 2),
                             to_transfer_m2=round(max(0.0, v - free.get(k, 0.0)), 2))
                for k, v in need_m2.items()
            ),
            key=lambda s: -s.to_transfer_m2,
        )
    return FilmIssueBoardOut(areas=area_rows, rolls_on_areas=rolls, fabrika=fabrika, reserve_enabled=reserve_on)
