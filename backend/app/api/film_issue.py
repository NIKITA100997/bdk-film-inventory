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
from datetime import date, datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from app.api.production import _can_see_all_areas, _issued_unit_remaining_m, _task_out
from app.core.security import require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import Color, Material, Thickness
from app.models.events import EventType, MaterialEvent
from app.models.production import PlanSlot, ProductionTask, ProductionTaskLine
from app.models.sites import Site
from app.models.storage import Rack
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User

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
    from app.api.production import begin_read_cache

    begin_read_cache(db)
    pool_cache: dict = {}
    by_area: dict[str, list[FilmIssueLineOut]] = defaultdict(list)
    for t in tasks:
        # Фабрика берёт плёнку со своего склада, выдачу под строку не ведёт:
        # нужно — по тому, что ещё не произведено, а не «не выдано»
        from_site_stock = site_of(t.area) == "Фабрика"
        out = _task_out(db, t, pool_cache)
        src = {l.id: l for l in t.lines}
        for lo in out.lines:
            l = src.get(lo.id)
            if l is None or l.material_id is None or l.is_closed:
                continue
            need = round((float(l.quantity_pieces) + float(lo.defect_pieces)) * float(l.length_m), 2)
            issued = round(float(lo.issued_length_m), 2)
            to_issue = round(float(lo.shortfall_length_m), 2)
            covered = round(max(0.0, need - issued - to_issue), 2)
            sw = float(lo.strip_width_mm or l.width_mm)
            if from_site_stock:
                to_issue = round(float(lo.remaining_length_m), 2)
                covered, status = 0.0, "site_stock"
            elif to_issue <= 0.01:
                status = "issued" if issued >= need - 0.01 else "covered"
            else:
                status = "partial" if issued > 0 or covered > 0 else "none"
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
    issued_at = dict(
        db.query(MaterialEvent.unit_id, func.max(MaterialEvent.timestamp))
        .filter(MaterialEvent.event_type == EventType.VYDACHA_UCHASTKU)
        .group_by(MaterialEvent.unit_id)
    )
    rolls: list[AreaRollOut] = []
    for u in db.query(MaterialUnit).filter(MaterialUnit.status == UnitStatus.VYDAN_UCHASTKU, MaterialUnit.area.isnot(None)):
        if not all_areas and u.area != user.area:
            continue
        sku = u.material_sku
        line = db.get(ProductionTaskLine, u.production_task_line_id) if u.production_task_line_id else None
        rem = _issued_unit_remaining_m(db, u)
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
