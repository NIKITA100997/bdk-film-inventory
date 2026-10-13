from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.dictionaries import Part
from app.models.items import ItemComponent
from app.models.part_units import PartUnit, PartUnitEvent, PartUnitStatus
from app.models.users import User
from app.schemas.part_units import (
    PartUnitAdjust,
    PartUnitAdvance,
    PartUnitCreate,
    PartUnitEventOut,
    PartUnitOut,
    PartUnitPlace,
    PartUnitRecycle,
    PartUnitReturn,
    PartUnitIssue,
    PartUnitWriteOff,
)
from app.services.part_units import (
    issue_part_unit,
    adjust_part_unit,
    advance_part_unit,
    mint_part_unit,
    place_part_unit,
    recycle_part_units_fifo,
    reported_good_pieces_by_unit,
    return_part_unit,
    write_off_part_unit,
)
from app.services.production_orders import detail_targets, make_detail_from_unit, recycle_to_detail

router = APIRouter(prefix="/part-units", tags=["part-units"])

manage_part_units = require_permission("part_units.manage")
view_part_units = require_permission("part_units.manage", "part_units.view")
# список партий — ещё и цеху: отчёт мастера показывает «доступно партий» на участке (08.10)
list_part_units_perm = require_permission(
    "part_units.manage", "part_units.view", "production_tasks.report", "production_tasks.manage", "production_tasks.view"
)
# Раздел про ревизию путей плёнки/п/ф — узкое право, отдельное от
# part_units.manage: обычная выдача/списание доступны начальнику цеха,
# а формальная корректировка/возврат-без-повода — только тому, кому это
# явно доверили (плюс суперпользователь всегда, в обход этой проверки).
correct_part_units = require_permission("part_units.correct")


def _part_unit_out(unit: PartUnit, reported_good_pieces: float = 0.0) -> PartUnitOut:
    quantity = float(unit.quantity_pieces)
    return PartUnitOut(
        id=unit.id,
        parent_id=unit.parent_id,
        part_id=unit.part_id,
        part_name=unit.part.name,
        quantity_pieces=quantity,
        quantity_available=max(0.0, quantity - reported_good_pieces),
        stage_id=unit.stage_id,
        stage_name=unit.stage.name,
        status=unit.status,
        area=unit.area,
        location_code=unit.location_code,
        production_task_line_id=unit.production_task_line_id,
        note=unit.note,
        film_restriction=unit.film_restriction,
        created_by=unit.created_by,
        manufactured_at=unit.manufactured_at,
        created_at=unit.created_at,
        updated_at=unit.updated_at,
    )


def _part_unit_out_single(db: Session, unit: PartUnit) -> PartUnitOut:
    """Раздел про ревизию путей п/ф — вариант _part_unit_out для одной
    партии за раз (после мутации/создания): один запрос за отчитанным
    количеством, не N+1, но и без отдельного батч-словаря ради одной
    единицы."""
    reported = reported_good_pieces_by_unit(db, [unit.id])
    return _part_unit_out(unit, reported.get(unit.id, 0.0))


@router.get("", response_model=list[PartUnitOut])
def list_part_units(
    part_id: int | None = None,
    area: str | None = None,
    status_: PartUnitStatus | None = None,
    stage_id: int | None = None,
    production_task_line_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(list_part_units_perm),
) -> list[PartUnitOut]:
    query = db.query(PartUnit)
    if part_id is not None:
        query = query.filter(PartUnit.part_id == part_id)
    if area is not None:
        query = query.filter(PartUnit.area == area)
    if status_ is not None:
        query = query.filter(PartUnit.status == status_)
    if stage_id is not None:
        query = query.filter(PartUnit.stage_id == stage_id)
    if production_task_line_id is not None:
        query = query.filter(PartUnit.production_task_line_id == production_task_line_id)
    units = query.order_by(PartUnit.created_at.desc()).all()
    reported = reported_good_pieces_by_unit(db, [u.id for u in units])
    return [_part_unit_out(u, reported.get(u.id, 0.0)) for u in units]


@router.post("", response_model=PartUnitOut, status_code=status.HTTP_201_CREATED)
def create_part_unit(
    payload: PartUnitCreate, db: Session = Depends(get_db), user: User = Depends(manage_part_units)
) -> PartUnitOut:
    part = db.get(Part, payload.part_id)
    if part is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Деталь не найдена")
    try:
        unit = mint_part_unit(
            db,
            part=part,
            quantity_pieces=payload.quantity_pieces,
            user_id=user.id,
            production_task_line_id=payload.production_task_line_id,
            note=payload.note,
            stage_id=payload.stage_id,
            manufactured_at=payload.manufactured_at,
            film_restriction=payload.film_restriction,
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    db.refresh(unit)
    return _part_unit_out_single(db, unit)


@router.post("/recycle", response_model=PartUnitOut, status_code=status.HTTP_201_CREATED)
def recycle_part_units_endpoint(
    payload: PartUnitRecycle, db: Session = Depends(get_db), user: User = Depends(manage_part_units)
) -> PartUnitOut:
    """"Переработать в деталь" — раздел про переработку брака: забрать
    резерв (В_переработку) исходной детали по FIFO и заминтить новую
    партию другой детали сразу на этапе «Окутка»."""
    try:
        source = db.get(Part, payload.source_part_id)
        by_composition = source is not None and any(
            p.id == payload.target_part_id for p, _s, _q in detail_targets(db, source, from_defect=True)
        )
        if by_composition:
            # По составу («только брак») — партия на операции расхода, брак по норме.
            new_unit = recycle_to_detail(
                db, source_part_id=payload.source_part_id, area=payload.area, target_part_id=payload.target_part_id,
                quantity_pieces=payload.quantity_pieces, user_id=user.id, note=payload.note,
            )
        else:
            new_unit = recycle_part_units_fifo(
                db,
                source_part_id=payload.source_part_id,
                area=payload.area,
                quantity_pieces=payload.quantity_pieces,
                target_part_id=payload.target_part_id,
                user_id=user.id,
                note=payload.note,
            )
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    db.refresh(new_unit)
    return _part_unit_out_single(db, new_unit)


@router.get("/make-source-parts", response_model=list[int])
def make_source_parts(db: Session = Depends(get_db), user: User = Depends(view_part_units)) -> list[int]:
    """Детали, из которых по составу делаются другие (заготовка до фрезеровки
    → детали с пазом): у их партий на экране — «Сделать деталь»."""
    rows = (
        db.query(Part.id)
        .join(ItemComponent, ItemComponent.component_item_id == Part.item_id)
        .filter(ItemComponent.stage_id.isnot(None))
        .distinct()
    )
    return [r[0] for r in rows]


@router.get("/{unit_id}", response_model=PartUnitOut)
def get_part_unit(
    unit_id: int, db: Session = Depends(get_db), user: User = Depends(view_part_units)
) -> PartUnitOut:
    """Одна партия по ID (раздел про мобильный скан-сценарий по этапам) —
    зеркалит GET /units/{unit_id} у плёнки: карточка партии открывается
    сканом QR-этикетки, искать в целом списке ради одной партии незачем."""
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    return _part_unit_out_single(db, unit)


@router.patch("/{unit_id}/place", response_model=PartUnitOut)
def place_part_unit_endpoint(
    unit_id: int, payload: PartUnitPlace, db: Session = Depends(get_db), user: User = Depends(manage_part_units)
) -> PartUnitOut:
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    try:
        place_part_unit(db, unit=unit, location_code=payload.location_code, user_id=user.id, occurred_at=payload.occurred_at)
    except ValueError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    db.commit()
    db.refresh(unit)
    return _part_unit_out_single(db, unit)


class MakeTargetOut(BaseModel):
    part_id: int
    part_name: str
    operation: str
    per_unit: float


class MakeIn(BaseModel):
    target_part_id: int
    quantity_pieces: float = Field(gt=0)
    occurred_at: datetime | None = None


@router.get("/{unit_id}/make-targets", response_model=list[MakeTargetOut])
def make_targets(unit_id: int, db: Session = Depends(get_db), user: User = Depends(view_part_units)) -> list[MakeTargetOut]:
    """Какие детали можно сделать из этой партии (по составу: заготовка до
    фрезеровки → детали с пазом)."""
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    return [
        MakeTargetOut(part_id=p.id, part_name=p.name, operation=s.name, per_unit=q)
        for p, s, q in detail_targets(db, unit.part)
    ]


@router.get("/recycle-targets/{part_id}", response_model=list[MakeTargetOut])
def recycle_targets(part_id: int, db: Session = Depends(get_db), user: User = Depends(view_part_units)) -> list[MakeTargetOut]:
    """Во что по составу идёт брак детали (строки состава «только брак»)."""
    part = db.get(Part, part_id)
    if part is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Деталь не найдена")
    return [
        MakeTargetOut(part_id=p.id, part_name=p.name, operation=s.name, per_unit=q)
        for p, s, q in detail_targets(db, part, from_defect=True)
    ]


@router.post("/{unit_id}/make", response_model=PartUnitOut, status_code=status.HTTP_201_CREATED)
def make_from_unit(
    unit_id: int, payload: MakeIn, db: Session = Depends(get_db), user: User = Depends(manage_part_units)
) -> PartUnitOut:
    """«Сделать деталь из заготовки» — заготовка списывается в производство,
    партия детали рождается уже после операции (см. make_detail_from_unit)."""
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    try:
        new_unit = make_detail_from_unit(
            db, unit=unit, target_part_id=payload.target_part_id, quantity_pieces=payload.quantity_pieces,
            user_id=user.id, occurred_at=payload.occurred_at,
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    db.refresh(new_unit)
    return _part_unit_out_single(db, new_unit)


@router.post("/{unit_id}/issue", response_model=PartUnitOut)
def issue_part_unit_endpoint(
    unit_id: int, payload: PartUnitIssue, db: Session = Depends(get_db), user: User = Depends(manage_part_units)
) -> PartUnitOut:
    """«Передать на участок» — партию «На хранении» на участок её этапа."""
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    try:
        target = issue_part_unit(
            db, unit=unit, user_id=user.id, quantity_pieces=payload.quantity_pieces, occurred_at=payload.occurred_at
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    db.commit()
    db.refresh(target)
    return _part_unit_out_single(db, target)


@router.post("/{unit_id}/advance", response_model=PartUnitOut)
def advance_part_unit_endpoint(
    unit_id: int, payload: PartUnitAdvance, db: Session = Depends(get_db), user: User = Depends(manage_part_units)
) -> PartUnitOut:
    """Перевести партию на следующий этап напрямую (раздел про мобильный
    скан-сценарий по этапам) — не через отчёт мастера о производстве:
    для этапов вроде склейки/фрезеровки, где расхода плёнки нет и
    производственное задание заводить незачем. Тот же advance_part_unit,
    что уже вызывает create_task_line_report при good_pieces > 0 —
    здесь просто прямой доступ к нему."""
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    try:
        target, _ = advance_part_unit(
            db, unit=unit, quantity_pieces=payload.quantity_pieces, user_id=user.id, occurred_at=payload.occurred_at
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    db.commit()
    db.refresh(target)
    return _part_unit_out_single(db, target)


@router.post("/{unit_id}/write-off", response_model=PartUnitOut)
def write_off_part_unit_endpoint(
    unit_id: int, payload: PartUnitWriteOff, db: Session = Depends(get_db), user: User = Depends(manage_part_units)
) -> PartUnitOut:
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    try:
        target = write_off_part_unit(
            db,
            unit=unit,
            quantity_pieces=payload.quantity_pieces,
            reason=payload.reason,
            user_id=user.id,
            note=payload.note,
            occurred_at=payload.occurred_at,
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    db.commit()
    db.refresh(target)
    return _part_unit_out_single(db, target)


@router.post("/{unit_id}/return", response_model=PartUnitOut)
def return_part_unit_endpoint(
    unit_id: int, payload: PartUnitReturn, db: Session = Depends(get_db), user: User = Depends(correct_part_units)
) -> PartUnitOut:
    """Раздел про ревизию путей п/ф — зеркалит POST /units/{id}/return у
    плёнки: партия физически возвращается на склад, не использовав (или
    использовав частично) свой остаток."""
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    try:
        return_part_unit(
            db, unit=unit, actual_quantity_pieces=payload.actual_quantity_pieces, user_id=user.id, occurred_at=payload.occurred_at
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    db.commit()
    db.refresh(unit)
    return _part_unit_out_single(db, unit)


@router.post("/{unit_id}/adjust", response_model=PartUnitOut)
def adjust_part_unit_endpoint(
    unit_id: int, payload: PartUnitAdjust, db: Session = Depends(get_db), user: User = Depends(correct_part_units)
) -> PartUnitOut:
    """Раздел про ревизию путей п/ф — формальная корректировка
    quantity_pieces вместо правки истории напрямую в БД. Всегда
    добавляет событие (PartEventType.KORREKTIROVKA), не завязана на
    статус партии."""
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    adjust_part_unit(
        db, unit=unit, actual_quantity_pieces=payload.actual_quantity_pieces,
        reason=payload.reason, user_id=user.id, note=payload.note,
        film_restriction=payload.film_restriction, clear_film_restriction=payload.clear_film_restriction,
        occurred_at=payload.occurred_at,
    )
    db.commit()
    db.refresh(unit)
    return _part_unit_out_single(db, unit)


@router.get("/{unit_id}/events", response_model=list[PartUnitEventOut])
def list_part_unit_events(
    unit_id: int, db: Session = Depends(get_db), user: User = Depends(view_part_units)
) -> list[PartUnitEvent]:
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    return (
        db.query(PartUnitEvent)
        .filter(PartUnitEvent.part_unit_id == unit_id)
        .order_by(PartUnitEvent.occurred_at.desc())
        .all()
    )


# ─── сверка партий п/ф: засчитать готовую партию в задание (14.10) ───────────
# Партию оприходовали без задания (сделали раньше, завели вручную) — её
# можно засчитать в задание на эту деталь: строка задания считается
# сделанной на эти штуки (служебный отчёт «сделано без отчёта» — в выработку
# и себестоимость не идёт), партия помечается заданием и остаётся в
# остатке — её дальше расходует тот, для кого её делали (окутка по FIFO).

credit_perm = require_permission("part_units.manage", "production_tasks.manage")
# отдельный префикс: /part-units/{unit_id} перехватил бы «/part-units/unassigned»
lots_router = APIRouter(prefix="/part-lots", tags=["part-units"])
_ALIVE = (PartUnitStatus.NA_KHRANENII, PartUnitStatus.VYDAN_UCHASTKU)


class CreditLineOut(BaseModel):
    task_line_id: int
    task_id: int
    task_name: str
    area: str
    planned: float
    done: float
    remaining: float
    for_task_id: int | None = None


class UnassignedLotOut(BaseModel):
    id: int
    part_id: int
    part_name: str
    quantity_pieces: float
    stage_name: str
    status: str
    area: str | None
    manufactured_at: datetime | None = None
    created_at: datetime
    lines: list[CreditLineOut]


def _open_lines_by_part(db: Session, part_ids: set[int]) -> dict[int, list[CreditLineOut]]:
    from app.api.production import _line_report_aggregates
    from app.models.production import ProductionTask, ProductionTaskLine

    if not part_ids:
        return {}
    lines = (
        db.query(ProductionTaskLine, ProductionTask)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTask.is_active.is_(True), ProductionTaskLine.part_id.in_(part_ids))
        .all()
    )
    agg = _line_report_aggregates(db, [ln.id for ln, _ in lines])
    out: dict[int, list[CreditLineOut]] = {}
    for ln, t in lines:
        done = agg.get(ln.id, (0.0, 0.0))[0]
        left = float(ln.quantity_pieces) - done
        if left <= 0.001:
            continue
        out.setdefault(ln.part_id, []).append(CreditLineOut(
            task_line_id=ln.id, task_id=t.id, task_name=t.name or f"№{t.id}", area=t.area, planned=float(ln.quantity_pieces),
            done=round(done, 2), remaining=round(left, 2), for_task_id=t.for_task_id,
        ))
    for v in out.values():
        v.sort(key=lambda x: (x.for_task_id is None, -x.task_id))  # задания на п/ф — первыми, новые выше
    return out


@lots_router.get("/unassigned", response_model=list[UnassignedLotOut])
def unassigned_lots(db: Session = Depends(get_db), user: User = Depends(view_part_units)) -> list[UnassignedLotOut]:
    """Живые партии без задания и открытые строки заданий на ту же деталь."""
    units = (
        db.query(PartUnit)
        .filter(PartUnit.production_task_line_id.is_(None), PartUnit.status.in_(_ALIVE), PartUnit.quantity_pieces > 0)
        .order_by(PartUnit.created_at.desc())
        .all()
    )
    by_part = _open_lines_by_part(db, {u.part_id for u in units})
    return [
        UnassignedLotOut(
            id=u.id, part_id=u.part_id, part_name=u.part.name, quantity_pieces=float(u.quantity_pieces), stage_name=u.stage.name,
            status=u.status.value if hasattr(u.status, "value") else str(u.status), area=u.area,
            manufactured_at=datetime.combine(u.manufactured_at, datetime.min.time()) if u.manufactured_at else None,
            created_at=u.created_at, lines=by_part.get(u.part_id, []),
        )
        for u in units
    ]


class CreditIn(BaseModel):
    task_line_id: int
    quantity_pieces: float = Field(gt=0)


@lots_router.post("/{unit_id}/credit")
def credit_to_line(unit_id: int, payload: CreditIn, db: Session = Depends(get_db), user: User = Depends(credit_perm)) -> dict:
    from app.api.production import _line_report_aggregates
    from app.models.production import REPORT_CLOSE, ProductionTask, ProductionTaskLine, ProductionTaskLineReport

    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    if unit.production_task_line_id is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Партия уже привязана к заданию")
    if unit.status not in _ALIVE:
        raise HTTPException(status.HTTP_409_CONFLICT, "Партия списана или отложена в переработку")
    line = db.get(ProductionTaskLine, payload.task_line_id)
    task = db.get(ProductionTask, line.task_id) if line else None
    if line is None or task is None or not task.is_active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Открытая строка задания не найдена")
    if line.part_id != unit.part_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "В строке задания другая деталь")
    if payload.quantity_pieces > float(unit.quantity_pieces) + 0.001:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"В партии только {float(unit.quantity_pieces):g} шт")
    done = _line_report_aggregates(db, [line.id]).get(line.id, (0.0, 0.0))[0]
    left = float(line.quantity_pieces) - done
    if payload.quantity_pieces > left + 0.001:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"По строке осталось сделать {left:g} шт")
    db.add(ProductionTaskLineReport(
        task_line_id=line.id, good_pieces=payload.quantity_pieces, defect_pieces=0, counts_toward_line=True, film_used_m=0,
        kind=REPORT_CLOSE, note=f"Засчитана готовая партия п/ф №{unit.id}", reported_by=user.id,
    ))
    unit.production_task_line_id = line.id
    db.commit()
    return {"ok": True, "task_id": task.id, "remaining": round(left - payload.quantity_pieces, 2)}


class RegradeIn(BaseModel):
    part_id: int
    reason: str = Field(min_length=2, max_length=200)
    stage_id: int | None = None


@router.post("/{unit_id}/regrade", response_model=PartUnitOut)
def regrade(unit_id: int, payload: RegradeIn, db: Session = Depends(get_db), user: User = Depends(correct_part_units)) -> PartUnitOut:
    """Пересорт: партия заведена не той деталью (14.10)."""
    from app.services.part_units import regrade_part_unit

    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    try:
        regrade_part_unit(db, unit=unit, part_id=payload.part_id, user_id=user.id, reason=payload.reason, stage_id=payload.stage_id)
    except ValueError as e:
        db.rollback()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    db.refresh(unit)
    return _part_unit_out(unit, reported_good_pieces_by_unit(db, [unit.id]).get(unit.id, 0.0))


# ─── удалить ошибочную партию, разделить партию (14.10, как у рулона) ────────


def delete_part_unit_impl(db: Session, unit: PartUnit) -> None:
    """Ошибочно заведённая партия — удаляется вместе со своим журналом (как
    рулон). Нельзя, если от неё отделены другие партии или по ней уже
    были отчёты — тогда это не ошибка ввода, а история производства."""
    from app.models.production import ProductionTaskLineReport

    if db.query(PartUnit.id).filter(PartUnit.parent_id == unit.id).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Нельзя удалить — от партии отделены другие, удалите сначала их")
    if db.query(ProductionTaskLineReport.id).filter(ProductionTaskLineReport.part_unit_id == unit.id).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Нельзя удалить — по партии есть отчёты производства; спишите её")
    db.query(PartUnitEvent).filter(PartUnitEvent.part_unit_id == unit.id).delete()
    db.delete(unit)


class DeleteOut(BaseModel):
    deleted: bool
    requested: bool


@router.delete("/{unit_id}", response_model=DeleteOut)
def delete_part_unit(unit_id: int, db: Session = Depends(get_db), user: User = Depends(manage_part_units)) -> DeleteOut:
    """Администратор удаляет сразу, остальные — заявкой на удаление."""
    from app.services.deletion_requests import request_deletion

    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    if not user.is_superuser:
        request_deletion(db, entity_type="part_unit", entity_id=unit.id,
                         entity_label=f"Партия п/ф №{unit.id} — {unit.part.name}, {float(unit.quantity_pieces):g} шт", requested_by=user.id)
        db.commit()
        return DeleteOut(deleted=False, requested=True)
    delete_part_unit_impl(db, unit)
    db.commit()
    return DeleteOut(deleted=True, requested=False)


class SplitIn(BaseModel):
    quantity_pieces: float = Field(gt=0)
    location_code: str | None = None


@router.post("/{unit_id}/split", response_model=PartUnitOut)
def split_part_unit(unit_id: int, payload: SplitIn, db: Session = Depends(get_db), user: User = Depends(manage_part_units)) -> PartUnitOut:
    """Разделить партию: часть — отдельной партией (своё место, своя
    этикетка), как отрезать остаток рулона. Делится только свободное
    (не отчитанное в производстве)."""
    from app.models.part_units import PartEventType
    from app.services.part_units import _split_or_reuse, record_part_event

    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Партия не найдена")
    if unit.status not in (PartUnitStatus.NA_KHRANENII, PartUnitStatus.VYDAN_UCHASTKU):
        raise HTTPException(status.HTTP_409_CONFLICT, "Делить можно партию на хранении или на участке")
    free = float(unit.quantity_pieces) - reported_good_pieces_by_unit(db, [unit.id]).get(unit.id, 0.0)
    if payload.quantity_pieces >= free - 1e-9:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Отделить можно меньше, чем свободно в партии ({free:g} шт)")
    child = _split_or_reuse(db, unit, payload.quantity_pieces)
    loc = (payload.location_code or "").strip() or None
    child.location_code = loc if loc else unit.location_code
    record_part_event(db, unit=child, event_type=PartEventType.RAZMESHCHENIE, user_id=user.id, quantity_delta=0,
                      from_cell=unit.location_code, to_cell=child.location_code, note=f"Отделено от партии №{unit.id}", related_part_unit_id=unit.id)
    db.commit()
    db.refresh(child)
    return _part_unit_out(child, 0.0)
