"""Производительность участков (07.10.2026): сколько и чего сделано за
период — по дням, участкам и позициям (из отчётов мастеров), и сколько
плёнки склад выдал участкам (события выдачи). Выгрузка — на фронте."""

from collections import defaultdict
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import Color, Material, MaterialSku, Thickness
from app.models.events import EventType, MaterialEvent
from app.models.production import REPORT_RECON, REPORT_REMAINDER, ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.units import MaterialUnit
from app.models.users import User
from app.services.production import report_film_m

router = APIRouter(prefix="/productivity", tags=["productivity"])
view = require_permission("reports.view", "production_tasks.view", "production_tasks.manage")
TZ = ZoneInfo("Europe/Moscow")


class OutputRow(BaseModel):
    day: date
    area: str
    area_name: str
    position: str  # деталь / изделие строки задания
    good: float
    defect: float
    film_m: float
    reports: int
    closed_whole: float  # из них засчитано закрытием «всё сделано» без отчёта


class IssueRow(BaseModel):
    day: date
    area: str
    area_name: str
    film: str
    rolls: int  # целых рулонов
    strips: int
    length_m: float
    area_m2: float


class AreaTotal(BaseModel):
    area: str
    area_name: str
    good: float
    defect: float
    defect_percent: float | None
    days_with_output: int
    good_per_day: float | None
    film_used_m: float
    issued_m: float
    issued_m2: float
    issued_units: int


class ProductivityOut(BaseModel):
    date_from: date
    date_to: date
    totals: list[AreaTotal]
    output: list[OutputRow]
    issues: list[IssueRow]


def _bounds(d1: date, d2: date) -> tuple[datetime, datetime]:
    return datetime.combine(d1, time.min, tzinfo=TZ), datetime.combine(d2 + timedelta(days=1), time.min, tzinfo=TZ)


def _day(ts: datetime) -> date:
    return ts.astimezone(TZ).date()


@router.get("", response_model=ProductivityOut)
def productivity(
    date_from: date = Query(...),
    date_to: date = Query(...),
    area: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(view),
) -> ProductivityOut:
    if date_to < date_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Конец периода раньше начала")
    if (date_to - date_from).days > 400:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Период — не больше 400 дней")
    start, end = _bounds(date_from, date_to)
    names = {a.code: a.name for a in db.query(Area)}

    # --- выпуск: отчёты мастеров (без служебных досчётов расхода рулона)
    q = (
        db.query(ProductionTaskLineReport, ProductionTaskLine, ProductionTask.area)
        .join(ProductionTaskLine, ProductionTaskLine.id == ProductionTaskLineReport.task_line_id)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTaskLineReport.reported_at >= start, ProductionTaskLineReport.reported_at < end)
        .filter((ProductionTaskLineReport.kind.is_(None)) | (ProductionTaskLineReport.kind.notin_([REPORT_RECON, REPORT_REMAINDER])))
    )
    if area:
        q = q.filter(ProductionTask.area == area)
    out: dict[tuple, dict] = {}
    for r, ln, a in q:
        key = (_day(r.reported_at), a, ln.part_name or "—")
        g = out.setdefault(key, {"good": 0.0, "defect": 0.0, "film": 0.0, "n": 0, "closed": 0.0})
        good, bad = float(r.good_pieces or 0), float(r.defect_pieces or 0)
        g["good"] += good
        g["defect"] += bad
        g["n"] += 1
        if r.kind == "close":
            g["closed"] += good
        if ln.material_id:
            g["film"] += report_film_m(good, bad, float(ln.length_m or 0), None if r.film_used_m is None else float(r.film_used_m))
    output = [
        OutputRow(day=d, area=a, area_name=names.get(a, a), position=pos, good=round(v["good"], 2), defect=round(v["defect"], 2),
                  film_m=round(v["film"], 2), reports=v["n"], closed_whole=round(v["closed"], 2))
        for (d, a, pos), v in out.items()
    ]
    output.sort(key=lambda x: (x.day, x.area_name, x.position))

    # --- выдача плёнки участкам
    eq = (
        db.query(MaterialEvent, MaterialUnit.is_strip)
        .join(MaterialUnit, MaterialUnit.id == MaterialEvent.unit_id)
        .filter(MaterialEvent.event_type == EventType.VYDACHA_UCHASTKU, MaterialEvent.timestamp >= start, MaterialEvent.timestamp < end)
    )
    if area:
        eq = eq.filter(MaterialEvent.area == area)
    rows = eq.all()
    sku_ids = {e.material_sku_id for e, _ in rows}
    films: dict[int, str] = {}
    if sku_ids:
        mat = {m.id: m.name for m in db.query(Material)}
        col = {c.id: c.name for c in db.query(Color)}
        thk = {t.id: float(t.value_mm) for t in db.query(Thickness)}
        for s in db.query(MaterialSku).filter(MaterialSku.id.in_(sku_ids)):
            films[s.id] = f"{mat.get(s.material_id, '')} {col.get(s.color_id, '')}, {thk.get(s.thickness_id, 0):g} мм".strip()
    iss: dict[tuple, dict] = {}
    for e, is_strip in rows:
        a = e.area or "—"
        key = (_day(e.timestamp), a, films.get(e.material_sku_id, "—"))
        g = iss.setdefault(key, {"rolls": 0, "strips": 0, "m": 0.0, "m2": 0.0})
        # выданная длина — списание метража со склада в событии выдачи
        length = -float(e.quantity_delta_m) if float(e.quantity_delta_m or 0) < 0 else float(e.to_length or e.from_length or 0)
        g["strips" if is_strip else "rolls"] += 1
        g["m"] += length
        g["m2"] += length * float(e.width_mm or 0) / 1000
    issues = [
        IssueRow(day=d, area=a, area_name=names.get(a, a), film=f, rolls=v["rolls"], strips=v["strips"], length_m=round(v["m"], 2),
                 area_m2=round(v["m2"], 2))
        for (d, a, f), v in iss.items()
    ]
    issues.sort(key=lambda x: (x.day, x.area_name, x.film))

    # --- итоги по участкам
    tot: dict[str, dict] = defaultdict(lambda: {"good": 0.0, "defect": 0.0, "days": set(), "film": 0.0, "im": 0.0, "im2": 0.0, "iu": 0})
    for o in output:
        t = tot[o.area]
        t["good"] += o.good
        t["defect"] += o.defect
        t["film"] += o.film_m
        if o.good > 0:
            t["days"].add(o.day)
    for i in issues:
        t = tot[i.area]
        t["im"] += i.length_m
        t["im2"] += i.area_m2
        t["iu"] += i.rolls + i.strips
    totals = []
    for a, t in tot.items():
        made = t["good"] + t["defect"]
        days = len(t["days"])
        totals.append(AreaTotal(
            area=a, area_name=names.get(a, a), good=round(t["good"], 2), defect=round(t["defect"], 2),
            defect_percent=round(t["defect"] / made * 100, 1) if made else None, days_with_output=days,
            good_per_day=round(t["good"] / days, 1) if days else None, film_used_m=round(t["film"], 2),
            issued_m=round(t["im"], 2), issued_m2=round(t["im2"], 2), issued_units=t["iu"],
        ))
    totals.sort(key=lambda x: (-x.good, x.area_name))
    return ProductivityOut(date_from=date_from, date_to=date_to, totals=totals, output=output, issues=issues)
