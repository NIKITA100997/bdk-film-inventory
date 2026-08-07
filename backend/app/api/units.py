from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_roles
from app.db.session import get_db
from app.models.events import EventType
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.schemas.units import IssueRequest, MaterialUnitOut, PlaceRequest, ReceiveRequest, SplitRequest, SplitResponse
from app.services.events import record_event
from app.services.splitting import split_lengthwise

router = APIRouter(prefix="/units", tags=["units"])


@router.post("/receive", response_model=list[MaterialUnitOut], status_code=status.HTTP_201_CREATED)
def receive(
    payload: ReceiveRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("operator_sklada")),
) -> list[MaterialUnit]:
    """Приёмка партии (6.2 ТЗ): создаёт N единиц-рулонов под одним УПД/паллетой."""
    created: list[MaterialUnit] = []
    for _ in range(payload.quantity):
        unit = MaterialUnit(
            upd_number=payload.upd_number,
            pallet_number=payload.pallet_number,
            material=payload.material,
            color=payload.color,
            thickness=payload.thickness,
            manufacturer=payload.manufacturer,
            width_mm=payload.width_mm,
            length_m=payload.length_m,
            status=UnitStatus.NA_KHRANENII if payload.location_code else UnitStatus.PRINYAT,
            location_code=payload.location_code,
        )
        db.add(unit)
        db.flush()  # получить unit.id для события
        record_event(
            db,
            unit=unit,
            event_type=EventType.PRIHOD,
            user_id=user.id,
            quantity_delta_m=payload.length_m,
            to_length=payload.length_m,
            to_cell=payload.location_code,
        )
        created.append(unit)
    db.commit()
    for unit in created:
        db.refresh(unit)
    return created


@router.get("/{unit_id}", response_model=MaterialUnitOut)
def get_unit(
    unit_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MaterialUnit:
    unit = db.get(MaterialUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")
    return unit


def _get_storable_unit(db: Session, unit_id: int) -> MaterialUnit:
    unit = db.get(MaterialUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")
    return unit


@router.patch("/{unit_id}/place", response_model=MaterialUnitOut)
def place_unit(
    unit_id: int,
    payload: PlaceRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("operator_sklada", "kladovshchik")),
) -> MaterialUnit:
    """Размещение в ячейку (4/5.3 ТЗ) — переводит только что принятую
    единицу в статус "На хранении" с адресом на складе."""
    unit = _get_storable_unit(db, unit_id)
    if unit.status not in (UnitStatus.PRINYAT, UnitStatus.NA_KHRANENII):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Единицу нельзя разместить в её текущем статусе")
    from_cell = unit.location_code
    unit.status = UnitStatus.NA_KHRANENII
    unit.location_code = payload.location_code
    record_event(
        db,
        unit=unit,
        event_type=EventType.PRIHOD,
        user_id=user.id,
        from_cell=from_cell,
        to_cell=payload.location_code,
    )
    db.commit()
    db.refresh(unit)
    return unit


@router.post("/{unit_id}/split", response_model=SplitResponse)
def split_unit(
    unit_id: int,
    payload: SplitRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("operator_sklada")),
) -> SplitResponse:
    """Продольная резка (2.3/2.4 ТЗ) — всегда на складе, из статуса "На
    хранении". Одна часть остаётся тем же ID, другая — новой единицей."""
    unit = _get_storable_unit(db, unit_id)
    if unit.status != UnitStatus.NA_KHRANENII:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Резать можно только единицу на хранении")

    try:
        outcome = split_lengthwise(unit, payload.separate_width_mm, new_unit_location=payload.new_unit_location)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))

    unit.width_mm = outcome.parent_width_mm
    unit.length_m = outcome.parent_length_m
    record_event(
        db,
        unit=unit,
        event_type=outcome.parent_event.event_type,
        user_id=user.id,
        quantity_delta_m=outcome.parent_event.quantity_delta_m,
        from_length=outcome.parent_event.from_length,
        to_length=outcome.parent_event.to_length,
    )

    new_unit: MaterialUnit | None = None
    if outcome.new_unit is not None:
        spec = outcome.new_unit
        new_unit = MaterialUnit(
            parent_id=spec.parent_id,
            upd_number=spec.upd_number,
            pallet_number=spec.pallet_number,
            material=spec.material,
            color=spec.color,
            thickness=spec.thickness,
            manufacturer=spec.manufacturer,
            width_mm=spec.width_mm,
            length_m=spec.length_m,
            status=spec.status,
            location_code=spec.location_code,
        )
        db.add(new_unit)
        db.flush()
        record_event(
            db,
            unit=new_unit,
            event_type=outcome.new_unit_event.event_type,
            user_id=user.id,
            quantity_delta_m=outcome.new_unit_event.quantity_delta_m,
            to_length=outcome.new_unit_event.to_length,
            to_cell=outcome.new_unit_event.to_cell,
        )

    db.commit()
    db.refresh(unit)
    if new_unit is not None:
        db.refresh(new_unit)
    return SplitResponse(parent=unit, new_unit=new_unit)


@router.post("/issue", response_model=MaterialUnitOut)
def issue_to_area(
    payload: IssueRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("operator_sklada")),
) -> MaterialUnit:
    """Выдача участку (2.9 п.1, 6.3 ТЗ) — точное совпадение по ширине среди
    единиц на хранении. Донор-штрипс (класс B/C) и рекомендация резать новый
    рулон — этап 7 (ABC-анализ), здесь не реализуются: если точного
    совпадения нет, фронтенд предлагает оператору резать/выбрать вручную."""
    candidate = (
        db.query(MaterialUnit)
        .filter(
            MaterialUnit.status == UnitStatus.NA_KHRANENII,
            MaterialUnit.material == payload.material,
            MaterialUnit.color == payload.color,
            MaterialUnit.thickness == payload.thickness,
            MaterialUnit.manufacturer == payload.manufacturer,
            MaterialUnit.width_mm == payload.width_mm,
            MaterialUnit.length_m >= payload.length_m,
        )
        .order_by(MaterialUnit.length_m.asc())
        .first()
    )
    if candidate is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Точного совпадения по ширине нет — предложите донор-резку вручную или новый рулон",
        )

    from_cell = candidate.location_code
    candidate.status = UnitStatus.VYDAN_UCHASTKU
    candidate.area = payload.area
    candidate.location_code = None
    candidate.order_id = payload.order_id
    record_event(
        db,
        unit=candidate,
        event_type=EventType.VYDACHA_UCHASTKU,
        user_id=user.id,
        quantity_delta_m=-float(candidate.length_m),
        from_cell=from_cell,
    )
    db.commit()
    db.refresh(candidate)
    return candidate
