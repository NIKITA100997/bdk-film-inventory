from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Query, Session, joinedload

from app.core.security import get_current_user, require_roles
from app.db.session import get_db
from app.models.dictionaries import MaterialSku
from app.models.events import EventType
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import Area, User
from app.schemas.units import (
    CutRequest,
    IssueRequest,
    MaterialUnitOut,
    PlaceRequest,
    ReceiveRequest,
    ReturnRequest,
    SplitRequest,
    SplitResponse,
)
from app.services.dictionaries import find_or_create_sku, find_sku
from app.services.events import record_event
from app.services.splitting import cut_to_length, split_lengthwise

router = APIRouter(prefix="/units", tags=["units"])


def _with_sku(query: Query) -> Query:
    """Единая точка eager-load цепочки material_sku → материал/цвет/толщина/
    производитель, чтобы сериализация MaterialUnitOut не била по БД N+1 раз."""
    return query.options(
        joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.material),
        joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.color),
        joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.thickness),
        joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.manufacturer),
    )


@router.post("/receive", response_model=list[MaterialUnitOut], status_code=status.HTTP_201_CREATED)
def receive(
    payload: ReceiveRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("operator_sklada")),
) -> list[MaterialUnit]:
    """Приёмка партии (6.2 ТЗ): создаёт N единиц-рулонов под одним УПД/
    паллетой. Позиция материала ищется в справочнике (2.1a) или создаётся на
    лету, если такой комбинации ещё нет (5.6)."""
    sku = find_or_create_sku(
        db, material=payload.material, color=payload.color, thickness=payload.thickness, manufacturer=payload.manufacturer
    )

    created: list[MaterialUnit] = []
    for _ in range(payload.quantity):
        unit = MaterialUnit(
            upd_number=payload.upd_number,
            pallet_number=payload.pallet_number,
            material_sku_id=sku.id,
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
    ids = [u.id for u in created]
    return _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id.in_(ids)).all()


@router.get("/{unit_id}", response_model=MaterialUnitOut)
def get_unit(
    unit_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MaterialUnit:
    unit = _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == unit_id).first()
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
    return _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == unit_id).first()


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
            material_sku_id=spec.material_sku_id,
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
    unit = _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == unit.id).first()
    if new_unit is not None:
        new_unit = _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == new_unit.id).first()
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
    sku = find_sku(
        db, material=payload.material, color=payload.color, thickness=payload.thickness, manufacturer=payload.manufacturer
    )
    candidate = None
    if sku is not None:
        candidate = (
            db.query(MaterialUnit)
            .filter(
                MaterialUnit.status == UnitStatus.NA_KHRANENII,
                MaterialUnit.material_sku_id == sku.id,
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
    return _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == candidate.id).first()


@router.post("/{unit_id}/cut", response_model=MaterialUnitOut)
def cut_unit(
    unit_id: int,
    payload: CutRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("operator_sklada", "nachalnik_uchastka")),
) -> MaterialUnit:
    """Раскрой по длине (2.4/6.4 ТЗ) — на складе (единица ещё "На хранении",
    совмещённая резка под цельнолистовые) либо на месте у цельнолистовых на
    стеллаже Б (единица уже "Выдан участку", area=Цельнолистовые_двери).
    Отрезанный кусок точного размера уходит в производство сразу — новая
    единица не создаётся, только событие в журнале."""
    unit = _get_storable_unit(db, unit_id)
    on_site_at_tselnolistovye = unit.status == UnitStatus.VYDAN_UCHASTKU and unit.area == Area.TSELNOLISTOVYE_DVERI
    if unit.status != UnitStatus.NA_KHRANENII and not on_site_at_tselnolistovye:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Раскрой по длине доступен только на складе или на месте у цельнолистовых дверей",
        )

    try:
        outcome = cut_to_length(unit, payload.cut_length_m, remainder_location=payload.remainder_location)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))

    unit.length_m = outcome.parent_length_m
    unit.status = outcome.parent_status
    if payload.remainder_location:
        unit.location_code = payload.remainder_location
    record_event(
        db,
        unit=unit,
        event_type=outcome.parent_event.event_type,
        user_id=user.id,
        quantity_delta_m=outcome.parent_event.quantity_delta_m,
        from_length=outcome.parent_event.from_length,
        to_length=outcome.parent_event.to_length,
        to_cell=outcome.parent_event.to_cell,
    )
    db.commit()
    return _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == unit_id).first()


@router.post("/{unit_id}/return", response_model=MaterialUnitOut)
def return_unit(
    unit_id: int,
    payload: ReturnRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("nachalnik_uchastka", "kladovshchik")),
) -> MaterialUnit:
    """Возврат остатка (2.4/6.5 ТЗ) — единый процесс для всех трёх участков,
    момент решает регламент участка. Статус → На хранении, зона С, area
    очищается; окончательное место на стеллаже задаётся позже через
    /units/{id}/place."""
    unit = _get_storable_unit(db, unit_id)
    if unit.status != UnitStatus.VYDAN_UCHASTKU:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Вернуть можно только единицу, выданную участку")

    old_length = float(unit.length_m)
    unit.length_m = payload.actual_length_m
    unit.status = UnitStatus.NA_KHRANENII
    unit.area = None
    unit.location_code = None
    record_event(
        db,
        unit=unit,
        event_type=EventType.VOZVRAT,
        user_id=user.id,
        quantity_delta_m=payload.actual_length_m - old_length,
        from_length=old_length,
        to_length=payload.actual_length_m,
    )
    db.commit()
    return _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == unit_id).first()


@router.get("/search/available", response_model=list[MaterialUnitOut])
def search_units(
    material: str | None = None,
    color: str | None = None,
    thickness: float | None = None,
    manufacturer: str | None = None,
    width_mm: float | None = None,
    min_length_m: float | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MaterialUnit]:
    """Поиск остатка (5.3 "Поиск остатка", 6.7 "погонаж" ТЗ) — фильтр по
    минимальной длине задаётся в метрах при конкретной ширине, не в м²."""
    query = _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.status == UnitStatus.NA_KHRANENII)
    if material:
        query = query.filter(MaterialUnit.material_sku.has(MaterialSku.material.has(name=material)))
    if color:
        query = query.filter(MaterialUnit.material_sku.has(MaterialSku.color.has(name=color)))
    if thickness is not None:
        query = query.filter(MaterialUnit.material_sku.has(MaterialSku.thickness.has(value_mm=thickness)))
    if manufacturer:
        query = query.filter(MaterialUnit.material_sku.has(MaterialSku.manufacturer.has(name=manufacturer)))
    if width_mm is not None:
        query = query.filter(MaterialUnit.width_mm == width_mm)
    if min_length_m is not None:
        query = query.filter(MaterialUnit.length_m >= min_length_m)
    return query.order_by(MaterialUnit.width_mm.asc(), MaterialUnit.length_m.desc()).limit(200).all()
