from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import get_permission_codes, require_permission
from app.db.session import get_db
from app.models.area_tasks import AreaTask, AreaTaskLine, AreaTaskReport
from app.models.areas import Area
from app.models.dictionaries import Part, PartStage
from app.models.users import User
from app.models.write_off_reasons import WriteOffReasonEntry
from app.schemas.area_tasks import (
    AreaPartStageOut,
    AreaTaskCreate,
    AreaTaskLineOut,
    AreaTaskOut,
    AreaTaskReportCreate,
    AreaTaskReportOut,
    AreaTaskUpdate,
)
from app.services.area_tasks import apply_report_to_part_units, validate_line_stage

router = APIRouter(prefix="/area-tasks", tags=["area-tasks"])

# Те же права, что у заданий с плёнкой: начальник цеха заводит, мастер
# участка отчитывается, мастер видит только свой участок.
manage_tasks = require_permission("production_tasks.manage")
report_tasks = require_permission("production_tasks.manage", "production_tasks.report")
view_tasks = require_permission("production_tasks.manage", "production_tasks.report", "production_tasks.view")


def _can_see_all_areas(user: User) -> bool:
    if user.is_superuser:
        return True
    codes = get_permission_codes(user)
    return "production_tasks.manage" in codes or "units.issue" in codes


def _get_task(db: Session, user: User, task_id: int) -> AreaTask:
    task = db.get(AreaTask, task_id)
    if task is None or not (_can_see_all_areas(user) or task.area == user.area):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Задание не найдено")
    return task


def _tasks_out(db: Session, tasks: list[AreaTask]) -> list[AreaTaskOut]:
    line_ids = [line.id for t in tasks for line in t.lines]
    aggs: dict[int, tuple[float, float]] = {}
    if line_ids:
        rows = (
            db.query(
                AreaTaskReport.line_id,
                func.coalesce(func.sum(AreaTaskReport.good_pieces), 0),
                func.coalesce(func.sum(AreaTaskReport.defect_pieces), 0),
            )
            .filter(AreaTaskReport.line_id.in_(line_ids))
            .group_by(AreaTaskReport.line_id)
            .all()
        )
        aggs = {lid: (float(g), float(d)) for lid, g, d in rows}
    stage_ids = {line.part_stage_id for t in tasks for line in t.lines if line.part_stage_id}
    stages = {s.id: s for s in db.query(PartStage).filter(PartStage.id.in_(stage_ids)).all()} if stage_ids else {}
    out = []
    for t in tasks:
        lines = []
        for line in t.lines:
            good, defect = aggs.get(line.id, (0.0, 0.0))
            stage = stages.get(line.part_stage_id) if line.part_stage_id else None
            lines.append(
                AreaTaskLineOut(
                    id=line.id,
                    sort_order=line.sort_order,
                    name=line.name,
                    quantity_pieces=float(line.quantity_pieces),
                    part_stage_id=line.part_stage_id,
                    part_id=stage.part_id if stage else None,
                    part_name=stage.part.name if stage else None,
                    stage_name=stage.name if stage else None,
                    note=line.note,
                    good_pieces=good,
                    defect_pieces=defect,
                    remaining_pieces=max(0.0, float(line.quantity_pieces) - good),
                )
            )
        out.append(
            AreaTaskOut(
                id=t.id, area=t.area, name=t.name, source=t.source, ship_date=t.ship_date, note=t.note,
                is_active=t.is_active, created_by=t.created_by, created_at=t.created_at, lines=lines,
            )
        )
    return out


@router.get("", response_model=list[AreaTaskOut])
def list_area_tasks(
    area: str | None = Query(default=None),
    include_closed: bool = Query(default=False),
    db: Session = Depends(get_db),
    user: User = Depends(view_tasks),
) -> list[AreaTaskOut]:
    if not _can_see_all_areas(user):
        area = user.area
        if area is None:
            return []
    query = db.query(AreaTask)
    if area is not None:
        query = query.filter(AreaTask.area == area)
    if not include_closed:
        query = query.filter(AreaTask.is_active.is_(True))
    tasks = query.order_by(AreaTask.ship_date.asc().nulls_last(), AreaTask.created_at.asc()).all()
    return _tasks_out(db, tasks)


@router.get("/part-stages", response_model=list[AreaPartStageOut])
def list_area_part_stages(
    area: str, db: Session = Depends(get_db), user: User = Depends(view_tasks)
) -> list[AreaPartStageOut]:
    """Этапы деталей п/ф, выполняемые на этом участке (кроме последних этапов
    многоэтапных деталей) — варианты привязки строки задания."""
    rows = (
        db.query(PartStage)
        .join(Part, Part.id == PartStage.part_id)
        .filter(PartStage.area == area, Part.is_active.is_(True))
        .order_by(Part.name, PartStage.sequence_order)
        .all()
    )
    out = []
    for s in rows:
        orders = sorted(x.sequence_order for x in s.part.stages)
        if len(orders) > 1 and s.sequence_order == orders[-1]:
            continue
        out.append(
            AreaPartStageOut(
                part_stage_id=s.id, part_id=s.part_id, part_name=s.part.name, stage_name=s.name,
                is_first=s.sequence_order == orders[0],
            )
        )
    return out


@router.post("", response_model=AreaTaskOut, status_code=status.HTTP_201_CREATED)
def create_area_task(
    payload: AreaTaskCreate, db: Session = Depends(get_db), user: User = Depends(manage_tasks)
) -> AreaTaskOut:
    if db.get(Area, payload.area) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Участок не найден")
    task = AreaTask(
        area=payload.area, name=payload.name.strip(), source="manual", ship_date=payload.ship_date,
        note=payload.note, is_active=True, created_by=user.id,
    )
    for i, line in enumerate(payload.lines):
        if line.part_stage_id is not None:
            try:
                validate_line_stage(db, task_area=payload.area, part_stage_id=line.part_stage_id)
            except ValueError as e:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Строка {i + 1}: {e}") from e
        task.lines.append(
            AreaTaskLine(
                sort_order=i, name=line.name.strip(), quantity_pieces=line.quantity_pieces,
                part_stage_id=line.part_stage_id, note=line.note,
            )
        )
    db.add(task)
    db.commit()
    db.refresh(task)
    return _tasks_out(db, [task])[0]


@router.patch("/{task_id}", response_model=AreaTaskOut)
def update_area_task(
    task_id: int, payload: AreaTaskUpdate, db: Session = Depends(get_db), user: User = Depends(manage_tasks)
) -> AreaTaskOut:
    task = _get_task(db, user, task_id)
    changes = payload.model_dump(exclude_unset=True)
    if "name" in changes and changes["name"] is not None:
        task.name = changes["name"].strip()
    for field in ("ship_date", "note"):
        if field in changes:
            setattr(task, field, changes[field])
    if changes.get("is_active") is not None:
        task.is_active = changes["is_active"]
    db.commit()
    db.refresh(task)
    return _tasks_out(db, [task])[0]


def _report_out(r: AreaTaskReport, names: dict[int, str]) -> AreaTaskReportOut:
    return AreaTaskReportOut(
        id=r.id, good_pieces=float(r.good_pieces), defect_pieces=float(r.defect_pieces),
        defect_reason=r.defect_reason, note=r.note, reported_by=r.reported_by,
        reported_by_name=names.get(r.reported_by, f"#{r.reported_by}"), occurred_at=r.occurred_at,
    )


def _get_line(task: AreaTask, line_id: int) -> AreaTaskLine:
    line = next((x for x in task.lines if x.id == line_id), None)
    if line is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Строка задания не найдена")
    return line


@router.get("/{task_id}/lines/{line_id}/reports", response_model=list[AreaTaskReportOut])
def list_line_reports(
    task_id: int, line_id: int, db: Session = Depends(get_db), user: User = Depends(view_tasks)
) -> list[AreaTaskReportOut]:
    line = _get_line(_get_task(db, user, task_id), line_id)
    user_ids = {r.reported_by for r in line.reports}
    names = {u.id: u.full_name for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    return [_report_out(r, names) for r in sorted(line.reports, key=lambda r: r.occurred_at, reverse=True)]


@router.post(
    "/{task_id}/lines/{line_id}/reports", response_model=AreaTaskReportOut, status_code=status.HTTP_201_CREATED
)
def create_line_report(
    task_id: int,
    line_id: int,
    payload: AreaTaskReportCreate,
    db: Session = Depends(get_db),
    user: User = Depends(report_tasks),
) -> AreaTaskReportOut:
    """Отчёт и движение партий п/ф — одной транзакцией: при любой ошибке не
    записывается ничего, повторное нажатие «Сохранить» безопасно."""
    task = _get_task(db, user, task_id)
    if not task.is_active:
        raise HTTPException(status.HTTP_409_CONFLICT, "Задание закрыто")
    line = _get_line(task, line_id)
    if payload.good_pieces <= 0 and payload.defect_pieces <= 0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите хорошие или брак")
    if payload.defect_pieces > 0:
        if not payload.defect_reason:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите причину брака")
        if db.get(WriteOffReasonEntry, payload.defect_reason) is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Причина брака не найдена")
    occurred_at = payload.occurred_at or datetime.now(timezone.utc)
    report = AreaTaskReport(
        line_id=line.id, good_pieces=payload.good_pieces, defect_pieces=payload.defect_pieces,
        defect_reason=payload.defect_reason if payload.defect_pieces > 0 else None, note=payload.note,
        reported_by=user.id, occurred_at=occurred_at,
    )
    db.add(report)
    if line.part_stage_id is not None:
        stage = db.get(PartStage, line.part_stage_id)
        try:
            apply_report_to_part_units(
                db, stage=stage, area=task.area, good_pieces=payload.good_pieces,
                defect_pieces=payload.defect_pieces, defect_reason=report.defect_reason,
                note=payload.note or f"Задание участку №{task.id}", user_id=user.id, occurred_at=occurred_at,
            )
        except ValueError as e:
            db.rollback()
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    db.refresh(report)
    return _report_out(report, {user.id: user.full_name})
