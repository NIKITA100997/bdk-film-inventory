"""Снабжение участков (15.10, этап 3): заявки участков, неснижаемый остаток
и факт резки/выдачи плёнки по дням и станкам. Логика — services/area_supply."""

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.production import _can_see_all_areas
from app.core.security import require_permission
from app.db.session import get_db
from app.models.area_supply import REQ_ACCEPTED, REQ_CANCELLED, REQ_DONE, REQ_NEW, REQ_OPEN, AreaRequest, AreaStockNorm
from app.models.areas import Area
from app.models.cutting_operations import CuttingOperation
from app.models.events import EventType, MaterialEvent
from app.models.production import ProductionLine
from app.models.users import User
from app.services import area_supply as svc

router = APIRouter(prefix="/area-supply", tags=["area-supply"])
view = require_permission("production_tasks.report", "production_tasks.manage", "production_tasks.view", "units.issue")
create = require_permission("production_tasks.report", "production_tasks.manage", "units.issue")
handle = require_permission("units.issue", "production_tasks.manage")
manage = require_permission("production_tasks.manage")


def _own_area(user: User) -> str | None:
    """Участок, которым ограничен пользователь; None — видит все."""
    return None if _can_see_all_areas(user) or not user.area else user.area


class CatalogOut(BaseModel):
    item_id: int
    kind: str
    label: str
    unit: str
    measurable: bool  # остаток на участке ведётся (плёнка, п/ф)


@router.get("/catalog", response_model=list[CatalogOut])
def get_catalog(kind: str | None = None, q: str | None = None, db: Session = Depends(get_db), user: User = Depends(view)) -> list[CatalogOut]:
    return [CatalogOut(item_id=i.item_id, kind=i.kind, label=i.label, unit=i.unit, measurable=svc.measurable(i)) for i in svc.catalog(db, kind, q)]


# ---------- заявки ----------


class RequestIn(BaseModel):
    area: str
    item_id: int | None = None
    what: str | None = Field(default=None, max_length=255)
    qty: float | None = Field(default=None, gt=0)
    width_mm: float | None = Field(default=None, gt=0)
    needed_by: date | None = None
    note: str | None = Field(default=None, max_length=255)


class RequestOut(BaseModel):
    id: int
    area: str
    area_name: str
    item_id: int | None
    kind: str | None
    label: str
    qty: float | None
    unit: str | None
    width_mm: float | None
    needed_by: date | None
    note: str | None
    status: str
    created_by_name: str | None
    created_at: datetime
    closed_by_name: str | None
    closed_at: datetime | None
    close_note: str | None
    area_stock: float | None  # сколько этого сейчас на участке (плёнка м², п/ф шт)


class CloseIn(BaseModel):
    note: str | None = Field(default=None, max_length=255)


def _req_out(db: Session, rows: list[AreaRequest]) -> list[RequestOut]:
    areas = {a.code: a.name for a in db.query(Area)}
    users = {u.id: (u.full_name or u.username) for u in db.query(User)}
    film = pf = None
    out = []
    for r in rows:
        info = svc.item_info(db, r.item_id) if r.item_id else None
        stock = None
        if info is not None and info.kind == svc.FILM:
            film = film if film is not None else svc.area_film_stock(db)
            stock = round(film.get((r.area, info.group), 0.0), 2)
        elif info is not None and info.part_id is not None:
            pf = pf if pf is not None else svc.area_pf_stock(db)
            stock = round(pf.get((r.area, info.part_id), 0.0), 2)
        out.append(RequestOut(
            id=r.id, area=r.area, area_name=areas.get(r.area, r.area), item_id=r.item_id, kind=info.kind if info else None,
            label=(info.label if info else None) or r.what or "—", qty=float(r.qty) if r.qty is not None else None,
            unit=r.unit, width_mm=float(r.width_mm) if r.width_mm is not None else None, needed_by=r.needed_by, note=r.note,
            status=r.status, created_by_name=users.get(r.created_by), created_at=r.created_at,
            closed_by_name=users.get(r.closed_by) if r.closed_by else None, closed_at=r.closed_at, close_note=r.close_note,
            area_stock=stock,
        ))
    return out


@router.get("/requests", response_model=list[RequestOut])
def list_requests(
    open_only: bool = True, kind: str | None = None, area: str | None = None, days: int = Query(default=30, ge=1, le=365),
    db: Session = Depends(get_db), user: User = Depends(view),
) -> list[RequestOut]:
    q = db.query(AreaRequest)
    own = _own_area(user)
    if own:
        q = q.filter(AreaRequest.area == own)
    elif area:
        q = q.filter(AreaRequest.area == area)
    if open_only:
        q = q.filter(AreaRequest.status.in_(REQ_OPEN))
    else:
        since = datetime.now(timezone.utc) - timedelta(days=days)
        q = q.filter((AreaRequest.status.in_(REQ_OPEN)) | (AreaRequest.created_at >= since))
    rows = q.order_by(AreaRequest.needed_by.asc().nulls_last(), AreaRequest.id).all()
    out = _req_out(db, rows)
    return [r for r in out if kind is None or r.kind == kind]


@router.post("/requests", response_model=RequestOut)
def create_request(payload: RequestIn, db: Session = Depends(get_db), user: User = Depends(create)) -> RequestOut:
    own = _own_area(user)
    if own and payload.area != own:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Заявку можно подать только от своего участка")
    if db.get(Area, payload.area) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Участок не найден")
    info = svc.item_info(db, payload.item_id) if payload.item_id else None
    if payload.item_id and info is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    if info is None and not (payload.what or "").strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите, что нужно")
    r = AreaRequest(
        area=payload.area, item_id=payload.item_id, what=(payload.what or "").strip() or None, qty=payload.qty,
        unit=info.unit if info else None, width_mm=payload.width_mm if (info is None or info.kind == svc.FILM) else None,
        needed_by=payload.needed_by, note=(payload.note or "").strip() or None, created_by=user.id,
    )
    db.add(r)
    db.commit()
    return _req_out(db, [r])[0]


def _get_open(db: Session, req_id: int) -> AreaRequest:
    r = db.get(AreaRequest, req_id)
    if r is None or r.status not in REQ_OPEN:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Открытая заявка не найдена")
    return r


@router.post("/requests/{req_id}/accept", response_model=RequestOut)
def accept_request(req_id: int, db: Session = Depends(get_db), user: User = Depends(handle)) -> RequestOut:
    r = _get_open(db, req_id)
    r.status = REQ_ACCEPTED
    db.commit()
    return _req_out(db, [r])[0]


@router.post("/requests/{req_id}/done", response_model=RequestOut)
def done_request(req_id: int, payload: CloseIn, db: Session = Depends(get_db), user: User = Depends(handle)) -> RequestOut:
    r = _get_open(db, req_id)
    r.status, r.closed_by, r.closed_at, r.close_note = REQ_DONE, user.id, datetime.now(timezone.utc), (payload.note or None)
    db.commit()
    return _req_out(db, [r])[0]


@router.post("/requests/{req_id}/cancel", response_model=RequestOut)
def cancel_request(req_id: int, payload: CloseIn, db: Session = Depends(get_db), user: User = Depends(create)) -> RequestOut:
    """Отменить: автор или склад/начальник цеха; мастер — только своего участка."""
    r = _get_open(db, req_id)
    own = _own_area(user)
    if own and r.area != own:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Заявка другого участка")
    r.status, r.closed_by, r.closed_at, r.close_note = REQ_CANCELLED, user.id, datetime.now(timezone.utc), (payload.note or None)
    db.commit()
    return _req_out(db, [r])[0]


# ---------- неснижаемый остаток участка ----------


class NormIn(BaseModel):
    area: str
    item_id: int
    min_qty: float = Field(ge=0)  # 0 — убрать норму


class NormOut(BaseModel):
    id: int
    area: str
    area_name: str
    item_id: int
    kind: str
    label: str
    unit: str
    min_qty: float
    have: float
    short: float  # не хватает до нормы
    open_request_id: int | None  # уже есть открытая заявка на эту позицию


@router.get("/norms", response_model=list[NormOut])
def list_norms(area: str | None = None, db: Session = Depends(get_db), user: User = Depends(view)) -> list[NormOut]:
    q = db.query(AreaStockNorm)
    own = _own_area(user)
    if own:
        q = q.filter(AreaStockNorm.area == own)
    elif area:
        q = q.filter(AreaStockNorm.area == area)
    rows = q.all()
    if not rows:
        return []
    areas = {a.code: a.name for a in db.query(Area)}
    film, pf = svc.area_film_stock(db), svc.area_pf_stock(db)
    open_req: dict[tuple[str, int], int] = {}
    for rid, a, iid in db.query(AreaRequest.id, AreaRequest.area, AreaRequest.item_id).filter(
        AreaRequest.status.in_(REQ_OPEN), AreaRequest.item_id.isnot(None)
    ):
        open_req.setdefault((a, iid), rid)
    out = []
    for n in rows:
        info = svc.item_info(db, n.item_id)
        if info is None:
            continue
        have = film.get((n.area, info.group), 0.0) if info.kind == svc.FILM else pf.get((n.area, info.part_id), 0.0)
        # заявка на другую позицию той же группы плёнки — тоже считается
        rid = open_req.get((n.area, n.item_id))
        if rid is None and info.kind == svc.FILM:
            for (a, iid), x in open_req.items():
                other = svc.item_info(db, iid) if a == n.area else None
                if other is not None and other.group == info.group:
                    rid = x
                    break
        out.append(NormOut(
            id=n.id, area=n.area, area_name=areas.get(n.area, n.area), item_id=n.item_id, kind=info.kind, label=info.label,
            unit=info.unit, min_qty=float(n.min_qty), have=round(have, 2), short=round(max(0.0, float(n.min_qty) - have), 2),
            open_request_id=rid,
        ))
    out.sort(key=lambda r: (r.short <= 0, r.area_name, r.label))
    return out


@router.put("/norms")
def put_norm(payload: NormIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> dict:
    if db.get(Area, payload.area) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Участок не найден")
    info = svc.item_info(db, payload.item_id)
    if info is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    if not svc.measurable(info):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Остаток на участке ведётся только для плёнки и п/ф — для материалов подавайте заявку")
    n = db.query(AreaStockNorm).filter(AreaStockNorm.area == payload.area, AreaStockNorm.item_id == payload.item_id).first()
    if payload.min_qty <= 0:
        if n is not None:
            db.delete(n)
    else:
        if n is None:
            n = AreaStockNorm(area=payload.area, item_id=payload.item_id, min_qty=payload.min_qty)
            db.add(n)
        n.min_qty, n.updated_by = payload.min_qty, user.id
    db.commit()
    return {"ok": True}


# ---------- факт резки и выдачи плёнки ----------


class IssueFactDay(BaseModel):
    day: date
    issued_m2: float  # выдано участкам
    issued_units: int
    cut_ops: int  # резок
    cut_m2: float  # снято с рулонов резкой
    by_line: dict[str, float]  # станок → м² резки; «не указан» — без станка


class IssueFactOut(BaseModel):
    lines: list[str]  # станки участков выдачи плёнки
    days: list[IssueFactDay]


@router.get("/issue-fact", response_model=IssueFactOut)
def issue_fact(days: int = Query(default=14, ge=1, le=90), db: Session = Depends(get_db), user: User = Depends(view)) -> IssueFactOut:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    issue_areas = [a.code for a in db.query(Area).filter(Area.film_issue_point.is_(True))]
    line_names = {l.id: l.name for l in db.query(ProductionLine).filter(ProductionLine.area.in_(issue_areas or ["-"]))}
    acc: dict[date, dict] = defaultdict(lambda: {"issued_m2": 0.0, "issued_units": 0, "cut_ops": 0, "cut_m2": 0.0, "by_line": defaultdict(float)})
    ev = db.query(MaterialEvent.timestamp, MaterialEvent.width_mm, MaterialEvent.quantity_delta_m).filter(
        MaterialEvent.event_type == EventType.VYDACHA_UCHASTKU, MaterialEvent.timestamp >= since
    )
    for ts, w, delta in ev:
        d = acc[ts.date()]
        d["issued_m2"] += float(w or 0) * abs(float(delta or 0)) / 1000  # выдача — расход со склада на всю длину
        d["issued_units"] += 1
    ops = db.query(CuttingOperation).filter(CuttingOperation.occurred_at >= since, CuttingOperation.undone_at.is_(None))
    for op in ops:
        d = acc[op.occurred_at.date()]
        m2 = max(0.0, (float(op.donor_width_before_mm) * float(op.donor_length_before_m) - float(op.donor_width_after_mm) * float(op.donor_length_after_m)) / 1000)
        d["cut_ops"] += 1
        d["cut_m2"] += m2
        d["by_line"][line_names.get(op.line_id, "не указан")] += m2
    out = [
        IssueFactDay(day=k, issued_m2=round(v["issued_m2"], 1), issued_units=v["issued_units"], cut_ops=v["cut_ops"],
                     cut_m2=round(v["cut_m2"], 1), by_line={n: round(x, 1) for n, x in v["by_line"].items()})
        for k, v in sorted(acc.items(), reverse=True)
    ]
    return IssueFactOut(lines=sorted(line_names.values()), days=out)


class CuttingLineOut(BaseModel):
    id: int
    name: str


@router.get("/cutting-lines", response_model=list[CuttingLineOut])
def cutting_lines(db: Session = Depends(get_db), user: User = Depends(view)) -> list[CuttingLineOut]:
    """Станки резки — активные линии участков, где режут и выдают плёнку."""
    codes = [a.code for a in db.query(Area).filter(Area.film_issue_point.is_(True), Area.is_active.is_(True))]
    if not codes:
        return []
    rows = db.query(ProductionLine).filter(ProductionLine.area.in_(codes), ProductionLine.is_active.is_(True)).order_by(ProductionLine.name)
    return [CuttingLineOut(id=l.id, name=l.name) for l in rows]
