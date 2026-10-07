"""«Ежедневка» (06.10) — цифровой бумажный бланк дневного отчёта линии/участка
(C:\\Users\\User\\Desktop\\Ежедневка.xlsx: 17 листов — окутка 1–6 Северный,
окутка 1–5 Фабрика, ламинация и мембранные прессы — с одинаковыми колонками).
Один отчёт на любой участок, линию и дату, собранный из отчётов мастеров:
Деталь | Цвет/материал | Ширина штрипса | № штрипса | Получено метров |
Произведено всего | Брак | Передано в производство | Расход плёнки | Остаток метров.

Получено — длина рулона при выдаче участку (событие выдачи, не текущая длина:
после возврата она меняется); расход — за этот день; остаток — получено минус
весь расход этого рулона по отчётам по конец дня."""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import Color, Material, Thickness
from app.models.events import EventType, MaterialEvent
from app.models.production import ProductionLine, ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.units import MaterialUnit
from app.models.users import User
from app.services.production import report_film_m

router = APIRouter(prefix="/daily-sheet", tags=["daily-sheet"])

view_production = require_permission("production_tasks.view", "production_tasks.report", "production_tasks.manage")
TZ = ZoneInfo("Europe/Moscow")


class SheetRow(BaseModel):
    task_id: int
    task_name: str | None
    part_name: str | None
    film: str | None
    strip_width_mm: float | None
    roll_id: int | None
    received_m: float | None
    produced: float
    defect: float
    passed: float
    consumed_m: float
    remaining_m: float | None
    line_name: str | None


class LineOpt(BaseModel):
    id: int
    name: str


class SheetOut(BaseModel):
    area: str
    area_name: str
    date: date
    line_id: int | None
    line_name: str | None
    lines: list[LineOpt]
    rows: list[SheetRow]
    without_line: int  # отчётов за день без линии (мастер не выбрал)


def _day_bounds(d: date) -> tuple[datetime, datetime]:
    start = datetime.combine(d, time.min, tzinfo=TZ)
    return start, start + timedelta(days=1)


@router.get("", response_model=SheetOut)
def daily_sheet(
    area: str,
    day: date = Query(alias="date"),
    line_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(view_production),
) -> SheetOut:
    a = db.get(Area, area)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Участок не найден")
    lines = db.query(ProductionLine).filter(ProductionLine.area == area, ProductionLine.is_active.is_(True)).order_by(ProductionLine.name).all()
    line_names = {pl.id: pl.name for pl in db.query(ProductionLine).filter(ProductionLine.area == area)}
    start, end = _day_bounds(day)
    q = (
        db.query(ProductionTaskLineReport, ProductionTaskLine, ProductionTask)
        .join(ProductionTaskLine, ProductionTaskLineReport.task_line_id == ProductionTaskLine.id)
        .join(ProductionTask, ProductionTaskLine.task_id == ProductionTask.id)
        .filter(ProductionTask.area == area, ProductionTaskLineReport.reported_at >= start, ProductionTaskLineReport.reported_at < end)
    )
    all_day = q.all()
    without_line = sum(1 for r, _, _ in all_day if r.line_id is None)
    day_rows = [x for x in all_day if line_id is None or x[0].line_id == line_id]

    # группа: строка задания × рулон × линия
    groups: dict[tuple, dict] = {}
    for r, ln, task in day_rows:
        key = (ln.id, r.material_unit_id, r.line_id if line_id is None else None)
        g = groups.setdefault(key, {"ln": ln, "task": task, "unit": r.material_unit_id, "line": r.line_id, "produced": 0.0, "defect": 0.0, "passed": 0.0, "consumed": 0.0})
        good, bad = float(r.good_pieces), float(r.defect_pieces)
        if r.counts_toward_line:
            g["produced"] += good + bad
            g["defect"] += bad
            g["passed"] += good
        g["consumed"] += report_film_m(good, bad, float(ln.length_m or 0), None if r.film_used_m is None else float(r.film_used_m))

    # справочники плёнки
    mat = {m.id: m.name for m in db.query(Material)}
    col = {c.id: c.name for c in db.query(Color)}
    thk = {t.id: float(t.value_mm) for t in db.query(Thickness)}

    unit_ids = {g["unit"] for g in groups.values() if g["unit"]}
    received: dict[int, float] = {}
    consumed_total: dict[int, float] = {}
    if unit_ids:
        # длина при выдаче — последнее событие выдачи по конец дня
        for ev in (
            db.query(MaterialEvent)
            .filter(MaterialEvent.unit_id.in_(unit_ids), MaterialEvent.event_type == EventType.VYDACHA_UCHASTKU, MaterialEvent.timestamp < end)
            .order_by(MaterialEvent.timestamp)
        ):
            # выданная длина — списание метража со склада в событии выдачи
            v = -float(ev.quantity_delta_m) if float(ev.quantity_delta_m or 0) < 0 else (ev.to_length if ev.to_length is not None else ev.from_length)
            if v is not None:
                received[ev.unit_id] = float(v)
        for uid in unit_ids - set(received):
            u = db.get(MaterialUnit, uid)
            if u is not None:
                received[uid] = float(u.length_m)
        # весь расход рулона по конец дня
        for rr, ln in (
            db.query(ProductionTaskLineReport, ProductionTaskLine)
            .join(ProductionTaskLine, ProductionTaskLineReport.task_line_id == ProductionTaskLine.id)
            .filter(ProductionTaskLineReport.material_unit_id.in_(unit_ids), ProductionTaskLineReport.reported_at < end)
        ):
            consumed_total[rr.material_unit_id] = consumed_total.get(rr.material_unit_id, 0.0) + report_film_m(
                float(rr.good_pieces), float(rr.defect_pieces), float(ln.length_m or 0),
                None if rr.film_used_m is None else float(rr.film_used_m),
            )

    rows = []
    for g in groups.values():
        ln, task, uid = g["ln"], g["task"], g["unit"]
        film = None
        if ln.material_id:
            film = f"{mat.get(ln.material_id, '')} {col.get(ln.color_id, '')}".strip()
            if ln.thickness_id in thk:
                film += f", {thk[ln.thickness_id]:g} мм"
        rec = received.get(uid) if uid else None
        rows.append(
            SheetRow(
                task_id=task.id, task_name=task.name, part_name=ln.part_name, film=film,
                strip_width_mm=float(ln.strip_width_mm or ln.width_mm) if (ln.strip_width_mm or ln.width_mm) else None,
                roll_id=uid, received_m=round(rec, 2) if rec is not None else None,
                produced=round(g["produced"], 2), defect=round(g["defect"], 2), passed=round(g["passed"], 2),
                consumed_m=round(g["consumed"], 2),
                remaining_m=round(max(0.0, rec - consumed_total.get(uid, 0.0)), 2) if rec is not None else None,
                line_name=line_names.get(g["line"]) if g["line"] else None,
            )
        )
    rows.sort(key=lambda x: (x.line_name or "", x.part_name or "", x.roll_id or 0))
    return SheetOut(
        area=area, area_name=a.name, date=day, line_id=line_id, line_name=line_names.get(line_id) if line_id else None,
        lines=[LineOpt(id=pl.id, name=pl.name) for pl in lines], rows=rows, without_line=without_line,
    )
