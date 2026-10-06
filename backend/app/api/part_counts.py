"""Пересчёт п/ф на участке — инвентаризация п/ф (06.10). Модель и смысл —
models/part_counts.py, логика — services/part_counts.py."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import Part, PartStage
from app.models.items import Item, ItemGroup
from app.models.part_counts import COUNT_CLOSED, COUNT_IN_PROGRESS, PartCountLine, PartCountSession
from app.models.users import User
from app.services import part_counts as svc

router = APIRouter(prefix="/part-counts", tags=["part-counts"])

count_part_units = require_permission("part_units.count")


class ScopeIn(BaseModel):
    group_ids: list[int] = []
    # стадии позиции: blank / bare / laminated / stripped
    stages: list[str] = []


class SessionCreate(BaseModel):
    area: str
    scope: ScopeIn = ScopeIn()
    note: str | None = Field(default=None, max_length=255)


class LineOut(BaseModel):
    id: int
    part_unit_id: int | None
    part_id: int
    part_name: str
    item_id: int | None
    group_name: str | None
    stage_id: int
    stage_name: str
    manufactured_at: str | None
    location_code: str | None
    expected_qty: float
    counted_qty: float | None
    diff: float | None
    decision: str | None
    allowed: list[str]
    reason: str | None
    note: str | None
    result_part_unit_id: int | None


class SessionOut(BaseModel):
    id: int
    area: str
    area_name: str
    scope: dict | None
    status: str
    note: str | None
    started_by: int
    started_at: datetime
    closed_at: datetime | None
    lines_total: int
    lines_counted: int
    lines_diff: int
    lines_open: int  # расхождения без решения (после закрытия)


class SessionDetail(SessionOut):
    lines: list[LineOut]


def _session(db: Session, session_id: int) -> PartCountSession:
    s = db.get(PartCountSession, session_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пересчёт не найден")
    return s


def _line(db: Session, s: PartCountSession, line_id: int) -> PartCountLine:
    line = db.get(PartCountLine, line_id)
    if line is None or line.session_id != s.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Строка не найдена")
    return line


def _summary(db: Session, s: PartCountSession, lines: list[PartCountLine]) -> dict:
    area = db.get(Area, s.area)
    diffs = [ln for ln in lines if svc.diff_of(float(ln.expected_qty), None if ln.counted_qty is None else float(ln.counted_qty))]
    return dict(
        id=s.id, area=s.area, area_name=area.name if area else s.area, scope=s.scope, status=s.status, note=s.note,
        started_by=s.started_by, started_at=s.started_at, closed_at=s.closed_at, lines_total=len(lines),
        lines_counted=sum(1 for ln in lines if ln.counted_qty is not None), lines_diff=len(diffs),
        lines_open=sum(1 for ln in diffs if ln.decision is None),
    )


def _lines_out(db: Session, lines: list[PartCountLine]) -> list[LineOut]:
    from app.models.part_units import PartUnit

    parts = {p.id: p for p in db.query(Part).filter(Part.id.in_({ln.part_id for ln in lines}))} if lines else {}
    stages = {st.id: st for st in db.query(PartStage).filter(PartStage.id.in_({ln.stage_id for ln in lines}))} if lines else {}
    units = (
        {u.id: u for u in db.query(PartUnit).filter(PartUnit.id.in_({ln.part_unit_id for ln in lines if ln.part_unit_id}))}
        if lines
        else {}
    )
    item_ids = {p.item_id for p in parts.values() if p.item_id}
    items = {i.id: i for i in db.query(Item).filter(Item.id.in_(item_ids))} if item_ids else {}
    groups = {g.id: g.name for g in db.query(ItemGroup)}
    out = []
    for ln in lines:
        part = parts.get(ln.part_id)
        item = items.get(part.item_id) if part and part.item_id else None
        unit = units.get(ln.part_unit_id) if ln.part_unit_id else None
        exp = float(ln.expected_qty)
        cnt = None if ln.counted_qty is None else float(ln.counted_qty)
        out.append(
            LineOut(
                id=ln.id, part_unit_id=ln.part_unit_id, part_id=ln.part_id, part_name=part.name if part else f"#{ln.part_id}",
                item_id=item.id if item else None, group_name=groups.get(item.group_id) if item and item.group_id else None,
                stage_id=ln.stage_id, stage_name=stages[ln.stage_id].name if ln.stage_id in stages else "—",
                manufactured_at=unit.manufactured_at.isoformat() if unit and unit.manufactured_at else None,
                location_code=unit.location_code if unit else None, expected_qty=exp, counted_qty=cnt,
                diff=svc.diff_of(exp, cnt), decision=ln.decision,
                allowed=svc.allowed_decisions(exp, cnt) if ln.decision is None else [], reason=ln.reason, note=ln.note,
                result_part_unit_id=ln.result_part_unit_id,
            )
        )
    out.sort(key=lambda x: (x.group_name or "", x.part_name, x.stage_name, x.manufactured_at or "", x.part_unit_id or 0))
    return out


def _detail(db: Session, s: PartCountSession) -> SessionDetail:
    lines = db.query(PartCountLine).filter(PartCountLine.session_id == s.id).all()
    return SessionDetail(**_summary(db, s, lines), lines=_lines_out(db, lines))


@router.get("", response_model=list[SessionOut])
def list_sessions(db: Session = Depends(get_db), user: User = Depends(count_part_units)) -> list[SessionOut]:
    sessions = db.query(PartCountSession).order_by(PartCountSession.started_at.desc()).limit(200).all()
    out = []
    for s in sessions:
        lines = db.query(PartCountLine).filter(PartCountLine.session_id == s.id).all()
        out.append(SessionOut(**_summary(db, s, lines)))
    return out


@router.post("", response_model=SessionDetail, status_code=status.HTTP_201_CREATED)
def start_session(payload: SessionCreate, db: Session = Depends(get_db), user: User = Depends(count_part_units)) -> SessionDetail:
    """Открыть пересчёт: лист — партии участка в охвате, «по учёту» —
    их свободное количество (за вычетом отчитанного в производстве)."""
    if db.get(Area, payload.area) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Участок не найден")
    scope = payload.scope.model_dump() if (payload.scope.group_ids or payload.scope.stages) else None
    s = PartCountSession(area=payload.area, scope=scope, status=COUNT_IN_PROGRESS, note=payload.note, started_by=user.id)
    db.add(s)
    db.flush()
    svc.build_lines(db, s)
    db.commit()
    return _detail(db, s)


@router.get("/{session_id}", response_model=SessionDetail)
def get_session(session_id: int, db: Session = Depends(get_db), user: User = Depends(count_part_units)) -> SessionDetail:
    return _detail(db, _session(db, session_id))


class CountIn(BaseModel):
    counted_qty: float | None = Field(default=None, ge=0)


@router.put("/{session_id}/lines/{line_id}", response_model=SessionDetail)
def set_count(
    session_id: int, line_id: int, payload: CountIn, db: Session = Depends(get_db), user: User = Depends(count_part_units)
) -> SessionDetail:
    """Факт по строке. «По учёту» обновляется в этот момент — если участок
    успел отчитаться после открытия, сравниваем с тем, что числилось сейчас."""
    s = _session(db, session_id)
    if s.status != COUNT_IN_PROGRESS:
        raise HTTPException(status.HTTP_409_CONFLICT, "Пересчёт уже закрыт")
    line = _line(db, s, line_id)
    if line.part_unit_id is not None:
        line.expected_qty = svc.current_free(db, line)
    line.counted_qty = payload.counted_qty
    line.counted_by = user.id if payload.counted_qty is not None else None
    line.counted_at = datetime.now(timezone.utc) if payload.counted_qty is not None else None
    db.commit()
    return _detail(db, s)


class ExtraIn(BaseModel):
    part_id: int
    counted_qty: float = Field(gt=0)


@router.post("/{session_id}/lines", response_model=SessionDetail, status_code=status.HTTP_201_CREATED)
def add_extra(session_id: int, payload: ExtraIn, db: Session = Depends(get_db), user: User = Depends(count_part_units)) -> SessionDetail:
    """Найдено сверх листа — деталь, которой на участке по учёту нет (или
    лишняя партия): строка без партии, этап — тот, что у детали на этом участке."""
    s = _session(db, session_id)
    if s.status != COUNT_IN_PROGRESS:
        raise HTTPException(status.HTTP_409_CONFLICT, "Пересчёт уже закрыт")
    stage = svc.stage_at_area(db, payload.part_id, s.area)
    if stage is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "У этой детали нет операции на этом участке")
    db.add(
        PartCountLine(
            session_id=s.id, part_unit_id=None, part_id=payload.part_id, stage_id=stage.id, expected_qty=0,
            counted_qty=payload.counted_qty, counted_by=user.id, counted_at=datetime.now(timezone.utc),
        )
    )
    db.commit()
    return _detail(db, s)


@router.delete("/{session_id}/lines/{line_id}", response_model=SessionDetail)
def remove_extra(session_id: int, line_id: int, db: Session = Depends(get_db), user: User = Depends(count_part_units)) -> SessionDetail:
    s = _session(db, session_id)
    if s.status != COUNT_IN_PROGRESS:
        raise HTTPException(status.HTTP_409_CONFLICT, "Пересчёт уже закрыт")
    line = _line(db, s, line_id)
    if line.part_unit_id is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Строку из листа не удалить — введите факт 0")
    db.delete(line)
    db.commit()
    return _detail(db, s)


@router.post("/{session_id}/close", response_model=SessionDetail)
def close_session(session_id: int, db: Session = Depends(get_db), user: User = Depends(count_part_units)) -> SessionDetail:
    """Закрыть пересчёт: факт больше не меняется, по расхождениям —
    решения. Не посчитанные строки остаются как по учёту."""
    s = _session(db, session_id)
    if s.status != COUNT_IN_PROGRESS:
        raise HTTPException(status.HTTP_409_CONFLICT, "Пересчёт уже закрыт")
    s.status = COUNT_CLOSED
    s.closed_by = user.id
    s.closed_at = datetime.now(timezone.utc)
    db.commit()
    return _detail(db, s)


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_session(session_id: int, db: Session = Depends(get_db), user: User = Depends(count_part_units)) -> None:
    """Отменить пересчёт, пока он открыт, — ничего ещё не применялось."""
    s = _session(db, session_id)
    if s.status != COUNT_IN_PROGRESS:
        raise HTTPException(status.HTTP_409_CONFLICT, "Закрытый пересчёт не отменяется")
    db.query(PartCountLine).filter(PartCountLine.session_id == s.id).delete()
    db.delete(s)
    db.commit()


class ResolveIn(BaseModel):
    decision: str
    reason: str | None = None
    note: str | None = Field(default=None, max_length=200)


@router.post("/{session_id}/lines/{line_id}/resolve", response_model=SessionDetail)
def resolve(
    session_id: int, line_id: int, payload: ResolveIn, db: Session = Depends(get_db), user: User = Depends(count_part_units)
) -> SessionDetail:
    """Решение по расхождению закрытого пересчёта: списать недостачу,
    оприходовать излишек или оставить учёт как есть — запись в журнал партии
    с номером пересчёта."""
    s = _session(db, session_id)
    if s.status != COUNT_CLOSED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Сначала закройте пересчёт")
    line = _line(db, s, line_id)
    if line.decision is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "По строке уже принято решение")
    try:
        svc.resolve_line(db, session=s, line=line, decision=payload.decision, reason=payload.reason, note=payload.note, user_id=user.id)
    except ValueError as e:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    db.commit()
    return _detail(db, s)


class AreaPartOut(BaseModel):
    part_id: int
    part_name: str
    stage_name: str


@router.get("/area-parts/{area}", response_model=list[AreaPartOut])
def area_parts(area: str, db: Session = Depends(get_db), user: User = Depends(count_part_units)) -> list[AreaPartOut]:
    """Детали, у которых есть операция на участке, — выбор для «найдено сверх листа»."""
    rows = (
        db.query(Part.id, Part.name, PartStage.name, PartStage.sequence_order)
        .join(PartStage, PartStage.part_id == Part.id)
        .filter(PartStage.area == area, Part.is_active.is_(True))
        .order_by(Part.name, PartStage.sequence_order.desc())
        .all()
    )
    seen: dict[int, AreaPartOut] = {}
    for pid, pname, sname, _ in rows:
        seen.setdefault(pid, AreaPartOut(part_id=pid, part_name=pname, stage_name=sname))
    return list(seen.values())
