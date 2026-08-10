from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Query, Session, joinedload

from app.core.security import get_current_user, require_roles
from app.db.session import get_db
from app.models.abc import CalcSettings, WidthAbcClass, WidthClass
from app.models.dictionaries import MaterialSku
from app.models.events import EventType, MaterialEvent
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import Area, User
from app.schemas.units import (
    CutRequest,
    DonorSuggestion,
    IssueDirectRequest,
    IssueRequest,
    IssueResult,
    MaterialUnitOut,
    PlaceRequest,
    ReceiveRequest,
    ReturnRequest,
    SplitRequest,
    SplitResponse,
    UnitEventOut,
)
from app.services.dictionaries import find_or_create_sku, find_sku
from app.services.events import record_event
from app.services.purchasing import auto_close_on_receipt
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
    auto_close_on_receipt(
        db, material_id=sku.material_id, color_id=sku.color_id, thickness_id=sku.thickness_id
    )
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


@router.get("/{unit_id}/events", response_model=list[UnitEventOut])
def unit_events(
    unit_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MaterialEvent]:
    """История единицы (2.1 раздел бэклога доработок) — для карточки
    единицы, "кто и когда с ней что делал"."""
    unit = db.get(MaterialUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")
    return (
        db.query(MaterialEvent)
        .filter(MaterialEvent.unit_id == unit_id)
        .order_by(MaterialEvent.timestamp.desc())
        .all()
    )


@router.post("/{unit_id}/write-off", response_model=MaterialUnitOut)
def write_off_unit(
    unit_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("operator_sklada", "kladovshchik")),
) -> MaterialUnit:
    """Списание вне инвентаризации (2.1 раздел бэклога доработок) — прямое
    действие из карточки единицы для остатка На_хранении, который решили
    не хранить дальше (порча, брак и т.п.)."""
    unit = _get_storable_unit(db, unit_id)
    if unit.status != UnitStatus.NA_KHRANENII:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Списать можно только единицу на хранении")
    old_length = float(unit.length_m)
    unit.status = UnitStatus.SPISAN
    record_event(
        db,
        unit=unit,
        event_type=EventType.SPISANIE,
        user_id=user.id,
        quantity_delta_m=-old_length,
        from_length=old_length,
        to_length=0,
    )
    db.commit()
    return _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == unit_id).first()


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
        settings = db.get(CalcSettings, 1)
        min_useful_width = float(settings.min_useful_width_mm) if settings else 30.0
        is_waste = spec.width_mm < min_useful_width

        new_unit = MaterialUnit(
            parent_id=spec.parent_id,
            upd_number=spec.upd_number,
            pallet_number=spec.pallet_number,
            material_sku_id=spec.material_sku_id,
            width_mm=spec.width_mm,
            length_m=spec.length_m,
            status=UnitStatus.SPISAN if is_waste else spec.status,
            location_code=None if is_waste else spec.location_code,
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
            to_cell=None if is_waste else outcome.new_unit_event.to_cell,
        )
        if is_waste:
            # Ниже порога полезной ширины (5.6 ТЗ) — сразу отход, на
            # штрипсовый стеллаж не идёт.
            record_event(
                db,
                unit=new_unit,
                event_type=EventType.SPISANIE,
                user_id=user.id,
                quantity_delta_m=-float(new_unit.length_m),
                from_length=float(new_unit.length_m),
                to_length=0,
            )

    db.commit()
    unit = _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == unit.id).first()
    if new_unit is not None:
        new_unit = _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == new_unit.id).first()
    return SplitResponse(parent=unit, new_unit=new_unit)


@router.post("/{unit_id}/issue", response_model=MaterialUnitOut)
def issue_unit_direct(
    unit_id: int,
    payload: IssueDirectRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("operator_sklada")),
) -> MaterialUnit:
    """Выдача конкретной единицы напрямую (3 раздел обратной связи) —
    оператор выбирает готовый рулон/штрипс из списка "в наличии" в карточке
    позиции материала, вместо поиска по атрибутам+ширине через /units/issue."""
    unit = _get_storable_unit(db, unit_id)
    if unit.status != UnitStatus.NA_KHRANENII:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Выдать можно только единицу на хранении")
    from_cell = unit.location_code
    unit.status = UnitStatus.VYDAN_UCHASTKU
    unit.area = payload.area
    unit.location_code = None
    unit.order_id = payload.order_id
    record_event(
        db,
        unit=unit,
        event_type=EventType.VYDACHA_UCHASTKU,
        user_id=user.id,
        quantity_delta_m=-float(unit.length_m),
        from_cell=from_cell,
    )
    db.commit()
    return _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == unit_id).first()


@router.post("/issue", response_model=IssueResult)
def issue_to_area(
    payload: IssueRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("operator_sklada")),
) -> IssueResult:
    """Выдача участку — алгоритм подбора (2.9 п.1-3, 6.3 ТЗ):
    1) точное совпадение по ширине → выдать;
    2) нет — штрипс шире, класса B/C, с минимальным отходом → предложить
       донора (не выполняется автоматически, оператор режет вручную через
       /units/{id}/split и повторяет выдачу на результат);
    3) донора тоже нет → "резать новый рулон" (вне системы)."""
    sku = find_sku(
        db, material=payload.material, color=payload.color, thickness=payload.thickness, manufacturer=payload.manufacturer
    )
    if sku is None:
        return IssueResult(outcome="not_found")

    exact = (
        db.query(MaterialUnit)
        .filter(
            MaterialUnit.status == UnitStatus.NA_KHRANENII,
            MaterialUnit.material_sku_id == sku.id,
            MaterialUnit.width_mm == payload.width_mm,
            MaterialUnit.length_m >= payload.length_m,
        )
        # Сначала самый старый остаток (дата прихода/нарезки — created_at,
        # 9 раздел бэклога доработок), среди равных по возрасту — короче
        # достаточного, чтобы не залёживались длинные куски.
        .order_by(MaterialUnit.created_at.asc(), MaterialUnit.length_m.asc())
        .first()
    )
    if exact is not None:
        from_cell = exact.location_code
        exact.status = UnitStatus.VYDAN_UCHASTKU
        exact.area = payload.area
        exact.location_code = None
        exact.order_id = payload.order_id
        record_event(
            db,
            unit=exact,
            event_type=EventType.VYDACHA_UCHASTKU,
            user_id=user.id,
            quantity_delta_m=-float(exact.length_m),
            from_cell=from_cell,
        )
        db.commit()
        unit = _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == exact.id).first()
        return IssueResult(outcome="issued", unit=unit)

    # Точного совпадения нет — ищем донора класса B/C шире запроса с
    # минимальным отходом среди тех, что физически есть на хранении.
    eligible_widths = {
        float(r.width_mm)
        for r in db.query(WidthAbcClass.width_mm)
        .filter(
            WidthAbcClass.material_id == sku.material_id,
            WidthAbcClass.color_id == sku.color_id,
            WidthAbcClass.thickness_id == sku.thickness_id,
            WidthAbcClass.width_class.in_([WidthClass.B, WidthClass.C]),
            WidthAbcClass.width_mm > payload.width_mm,
        )
        .all()
    }
    donor_unit = None
    if eligible_widths:
        donor_unit = (
            db.query(MaterialUnit)
            .filter(
                MaterialUnit.status == UnitStatus.NA_KHRANENII,
                MaterialUnit.material_sku_id == sku.id,
                MaterialUnit.width_mm.in_(eligible_widths),
                MaterialUnit.length_m >= payload.length_m,
            )
            # Тот же приоритет возраста, что и у точного совпадения выше —
            # донор-рекомендация в первую очередь выбирает самый старый
            # подходящий остаток, а не просто минимальный отход.
            .order_by(
                MaterialUnit.created_at.asc(),
                (MaterialUnit.width_mm - payload.width_mm).asc(),
                MaterialUnit.length_m.asc(),
            )
            .first()
        )
    if donor_unit is not None:
        cls = (
            db.query(WidthAbcClass.width_class)
            .filter(
                WidthAbcClass.material_id == sku.material_id,
                WidthAbcClass.color_id == sku.color_id,
                WidthAbcClass.thickness_id == sku.thickness_id,
                WidthAbcClass.width_mm == donor_unit.width_mm,
            )
            .scalar()
        )
        # Фиксируем сам факт рекомендации (не выполнение!) — источник для
        # отчёта "точность донор-рекомендаций" (5.5 ТЗ): считаем принятой,
        # если донор впоследствии реально был разрезан (Продольная_резка).
        record_event(
            db,
            unit=donor_unit,
            event_type=EventType.DONOR_PREDLOZHEN,
            user_id=user.id,
        )
        db.commit()
        return IssueResult(
            outcome="donor_suggested",
            donor=DonorSuggestion(
                unit_id=donor_unit.id,
                width_mm=float(donor_unit.width_mm),
                length_m=float(donor_unit.length_m),
                width_class=cls.value if cls else "?",
                recommended_cut_mm=payload.width_mm,
                waste_mm=round(float(donor_unit.width_mm) - payload.width_mm, 2),
            ),
        )

    return IssueResult(outcome="not_found")


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
    user: User = Depends(require_roles("nachalnik_uchastka", "kladovshchik", "operator_sklada")),
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
    status: UnitStatus | None = None,
    area: Area | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MaterialUnit]:
    """Поиск остатка (5.3 "Поиск остатка", 6.7 "погонаж" ТЗ) — фильтр по
    минимальной длине задаётся в метрах при конкретной ширине, не в м².

    Без явного `status` отдаёт всё, кроме списанного (2.2 раздел бэклога
    доработок — единый список материалов вместо трёх параллельных
    реализаций); мобильный «Поиск остатка» передаёт status=На_хранении
    явно, чтобы сохранить прежнее поведение "что реально доступно"."""
    query = _with_sku(db.query(MaterialUnit))
    if status is not None:
        query = query.filter(MaterialUnit.status == status)
    else:
        query = query.filter(MaterialUnit.status != UnitStatus.SPISAN)
    if area is not None:
        query = query.filter(MaterialUnit.area == area)
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
