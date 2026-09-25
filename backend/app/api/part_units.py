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
    PartUnitWriteOff,
)
from app.services.part_units import (
    adjust_part_unit,
    advance_part_unit,
    mint_part_unit,
    place_part_unit,
    recycle_part_units_fifo,
    reported_good_pieces_by_unit,
    return_part_unit,
    write_off_part_unit,
)
from app.services.production_orders import detail_targets, make_detail_from_unit

router = APIRouter(prefix="/part-units", tags=["part-units"])

manage_part_units = require_permission("part_units.manage")
view_part_units = require_permission("part_units.manage", "part_units.view")
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
    user: User = Depends(view_part_units),
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
