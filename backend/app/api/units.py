from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Query, Session, joinedload

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.abc import CalcSettings, WidthAbcClass, WidthClass
from app.models.dictionaries import MaterialSku
from app.models.events import EventType, MaterialEvent
from app.models.production import ProductionTaskLine, ProductionTaskLineReport
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.models.write_off_reasons import WriteOffReasonEntry
from app.schemas.deletion_requests import DeleteResultOut
from app.schemas.units import (
    AtomicDonorIssueRequest,
    AtomicDonorIssueResponse,
    CutRequest,
    CuttingPlanDonorOut,
    CuttingPlanOut,
    CuttingPlanRequest,
    DonorSuggestion,
    IssueDirectRequest,
    IssueRequest,
    IssueResult,
    MaterialUnitOut,
    PlaceRequest,
    ReassignSkuRequest,
    ReceiveRequest,
    ReturnPreviewOut,
    ReturnRequest,
    SplitRequest,
    SplitResponse,
    UnitEventOut,
    WriteOffRequest,
)
from app.services.cutting_plan import DonorCandidate, build_cutting_plan
from app.services.deletion_requests import request_deletion
from app.services.dictionaries import find_or_create_sku, find_sku
from app.services.events import record_event
from app.services.placement import rule_matches, rules_for_location
from app.services.production import calc_default_strip_width, compute_expected_return_length_m
from app.services.purchasing import auto_close_on_receipt
from app.services.splitting import cut_to_length, split_lengthwise

router = APIRouter(prefix="/units", tags=["units"])


def _validate_matches_task_line(db: Session, task_line_id: int, sku: MaterialSku, width_mm: float) -> None:
    """Строгое соответствие плёнки строке задания (раздел про строгую
    выдачу) — склад не может выдать не ту номенклатуру/ширину, что
    требует конкретная строка задания, даже если оператор вручную поменял
    поля после автоподстановки на фронте."""
    line = db.get(ProductionTaskLine, task_line_id)
    if line is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Строка задания не найдена")
    if (sku.material_id, sku.color_id, sku.thickness_id) != (line.material_id, line.color_id, line.thickness_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Плёнка не соответствует материалу строки задания")
    expected_w = (
        float(line.strip_width_mm)
        if line.strip_width_mm is not None
        else calc_default_strip_width(line.part_name, float(line.width_mm))
    )
    if abs(width_mm - expected_w) > 0.01:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Ширина не соответствует строке задания: нужно {expected_w} мм, запрошено {width_mm} мм",
        )


def _validate_zone_rule(db: Session, location_code: str | None, sku: MaterialSku) -> None:
    """Правило зонирования на конкретном адресе — не только подсказка для
    автоподбора, но и ограничение при явном вводе адреса руками (раздел
    про начальные остатки — до этой проверки можно было поставить любую
    плёнку на полку, закреплённую правилом за другой). Полки без единого
    правила остаются открытой зоной — ограничение только там, где правило
    реально задано и ни одно не подходит."""
    if not location_code:
        return
    rules = rules_for_location(db, location_code)
    if rules and not any(rule_matches(r, sku) for r in rules):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Полка {location_code} закреплена правилом зонирования за другой плёнкой",
        )


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
    user: User = Depends(require_permission("units.receive")),
) -> list[MaterialUnit]:
    """Приёмка партии (6.2 ТЗ): создаёт N единиц-рулонов под одним УПД/
    паллетой. Позиция материала ищется в справочнике (2.1a) или создаётся на
    лету, если такой комбинации ещё нет (5.6)."""
    sku = find_or_create_sku(
        db, material=payload.material, color=payload.color, thickness=payload.thickness, manufacturer=payload.manufacturer
    )
    _validate_zone_rule(db, payload.location_code, sku)

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
    payload: WriteOffRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("units.writeoff")),
) -> MaterialUnit:
    """Списание вне инвентаризации (2.1 раздел бэклога доработок) — прямое
    действие из карточки единицы для остатка На_хранении, который решили
    не хранить дальше (порча, брак и т.п.). Причина обязательна — данные
    для будущих претензий поставщику (10 раздел обратной связи)."""
    unit = _get_storable_unit(db, unit_id)
    if unit.status != UnitStatus.NA_KHRANENII:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Списать можно только единицу на хранении")
    reason = db.get(WriteOffReasonEntry, payload.reason)
    if reason is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Причина списания не найдена")
    if reason.is_system:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Причина 'Отход при раскрое' выставляется автоматически, не вручную",
        )
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
        write_off_reason=payload.reason,
        write_off_note=payload.note,
    )
    db.commit()
    return _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == unit_id).first()


def delete_unit_impl(db: Session, unit: MaterialUnit) -> None:
    """Раздел про удаление сущностей — если от единицы отрезан остаток
    (есть дочерние единицы), удалить нельзя: это разорвало бы историю
    разреза. Иначе удаляется вместе со своим журналом движений — она сама
    целиком перестаёт существовать, "терять" у неё уже нечего."""
    has_children = db.query(MaterialUnit.id).filter(MaterialUnit.parent_id == unit.id).first() is not None
    if has_children:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Нельзя удалить — от неё отрезан остаток, удалите сначала его"
        )
    db.query(MaterialEvent).filter(MaterialEvent.unit_id == unit.id).delete()
    db.delete(unit)


@router.delete("/{unit_id}", response_model=DeleteResultOut)
def delete_unit(
    unit_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("units.writeoff")),
) -> DeleteResultOut:
    unit = _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == unit_id).first()
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")
    if not user.is_superuser:
        sku = unit.material_sku
        label = f"№{unit.id} — {sku.material.name}, {sku.color.name}, {float(sku.thickness.value_mm)} мм, {float(unit.width_mm)}×{float(unit.length_m)} м"
        request_deletion(db, entity_type="material_unit", entity_id=unit.id, entity_label=label, requested_by=user.id)
        db.commit()
        return DeleteResultOut(deleted=False, requested=True)
    delete_unit_impl(db, unit)
    db.commit()
    return DeleteResultOut(deleted=True, requested=False)


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
    user: User = Depends(require_permission("units.place")),
) -> MaterialUnit:
    """Размещение в ячейку (4/5.3 ТЗ) — переводит только что принятую
    единицу в статус "На хранении" с адресом на складе."""
    unit = _get_storable_unit(db, unit_id)
    if unit.status not in (UnitStatus.PRINYAT, UnitStatus.NA_KHRANENII):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Единицу нельзя разместить в её текущем статусе")
    _validate_zone_rule(db, payload.location_code, unit.material_sku)
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


@router.patch("/{unit_id}/reassign-sku", response_model=MaterialUnitOut)
def reassign_unit_sku(
    unit_id: int,
    payload: ReassignSkuRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("materials.manage")),
) -> MaterialUnit:
    """Исправление ошибки ввода (раздел про карточку материала) — сменить
    номенклатуру уже существующей единицы без создания новой записи."""
    unit = _get_storable_unit(db, unit_id)
    sku = find_or_create_sku(
        db, material=payload.material, color=payload.color, thickness=payload.thickness, manufacturer=payload.manufacturer
    )
    unit.material_sku_id = sku.id
    db.commit()
    return _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == unit_id).first()


@router.post("/{unit_id}/split", response_model=SplitResponse)
def split_unit(
    unit_id: int,
    payload: SplitRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("units.split")),
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
                write_off_reason="cutting_waste",
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
    user: User = Depends(require_permission("units.issue")),
) -> MaterialUnit:
    """Выдача конкретной единицы напрямую (3 раздел обратной связи) —
    оператор выбирает готовый рулон/штрипс из списка "в наличии" в карточке
    позиции материала, вместо поиска по атрибутам+ширине через /units/issue."""
    unit = _get_storable_unit(db, unit_id)
    if unit.status != UnitStatus.NA_KHRANENII:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Выдать можно только единицу на хранении")
    if payload.production_task_line_id is not None:
        _validate_matches_task_line(db, payload.production_task_line_id, unit.material_sku, float(unit.width_mm))
    from_cell = unit.location_code
    unit.status = UnitStatus.VYDAN_UCHASTKU
    unit.area = payload.area
    unit.location_code = None
    unit.production_task_line_id = payload.production_task_line_id
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
    user: User = Depends(require_permission("units.issue")),
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
    if payload.production_task_line_id is not None:
        _validate_matches_task_line(db, payload.production_task_line_id, sku, payload.width_mm)

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
        exact.production_task_line_id = payload.production_task_line_id
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
        created_at_utc = donor_unit.created_at.replace(tzinfo=timezone.utc) if donor_unit.created_at.tzinfo is None else donor_unit.created_at
        days = max((datetime.now(timezone.utc) - created_at_utc).days, 0)
        return IssueResult(
            outcome="donor_suggested",
            donor=DonorSuggestion(
                unit_id=donor_unit.id,
                width_mm=float(donor_unit.width_mm),
                length_m=float(donor_unit.length_m),
                width_class=cls.value if cls else "?",
                recommended_cut_mm=payload.width_mm,
                waste_mm=round(float(donor_unit.width_mm) - payload.width_mm, 2),
                days_in_storage=days,
            ),
        )

    return IssueResult(outcome="not_found")


@router.post("/cutting-plan", response_model=CuttingPlanOut)
def get_cutting_plan(
    payload: CuttingPlanRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> CuttingPlanOut:
    """План резки одного донора сразу на несколько разных ширин штрипса
    одной плёнки (раздел про несколько разных потребностей за день) —
    щелевая резка режет рулон на несколько полос за один проход, поэтому
    если сегодня нужно несколько разных ширин одной и той же плёнки,
    выгоднее резать один донор сразу под несколько из них, а не по одной
    независимо, как /units/issue для отдельной строки. В отличие от
    одиночной донор-рекомендации, здесь НЕ ограничиваемся классом B/C
    ABC-анализа — это осознанный batch-подбор под конкретный список
    потребностей, а не "предложить с осторожностью" для одной строки."""
    sku = find_sku(
        db, material=payload.material, color=payload.color, thickness=payload.thickness, manufacturer=payload.manufacturer
    )
    if sku is None:
        return CuttingPlanOut(donor=None, covered_widths_mm=[], uncovered_widths_mm=payload.needed_widths_mm, waste_mm=0.0)

    settings = db.get(CalcSettings, 1)
    min_useful_width = float(settings.min_useful_width_mm) if settings else 30.0

    candidates = (
        db.query(MaterialUnit)
        .filter(
            MaterialUnit.status == UnitStatus.NA_KHRANENII,
            MaterialUnit.material_sku_id == sku.id,
            MaterialUnit.width_mm >= min(payload.needed_widths_mm),
        )
        .all()
    )
    now = datetime.now(timezone.utc)

    def _days(u: MaterialUnit) -> int:
        created = u.created_at.replace(tzinfo=timezone.utc) if u.created_at.tzinfo is None else u.created_at
        return max((now - created).days, 0)

    donors = [
        DonorCandidate(unit_id=u.id, width_mm=float(u.width_mm), length_m=float(u.length_m), days_in_storage=_days(u))
        for u in candidates
    ]
    plan = build_cutting_plan(payload.needed_widths_mm, donors, min_useful_width)

    if plan.donor is None:
        return CuttingPlanOut(donor=None, covered_widths_mm=[], uncovered_widths_mm=payload.needed_widths_mm, waste_mm=0.0)

    covered_widths = [payload.needed_widths_mm[i] for i in plan.covered_indices]
    uncovered_widths = [w for i, w in enumerate(payload.needed_widths_mm) if i not in plan.covered_indices]
    return CuttingPlanOut(
        donor=CuttingPlanDonorOut(
            unit_id=plan.donor.unit_id,
            width_mm=plan.donor.width_mm,
            length_m=plan.donor.length_m,
            days_in_storage=plan.donor.days_in_storage,
        ),
        covered_widths_mm=covered_widths,
        uncovered_widths_mm=uncovered_widths,
        waste_mm=plan.waste_mm,
    )


@router.post("/issue-donor-atomic", response_model=AtomicDonorIssueResponse)
def issue_donor_atomic(
    payload: AtomicDonorIssueRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("units.issue")),
) -> AtomicDonorIssueResponse:
    """Атомарная резка донора и выдача в 1 клик (раздел 6 бэклога доработок):
    берет донорский рулон/штрипс на хранении, отделяет от него кусок requested_width_mm,
    мгновенно выдает отделенный кусок участку, а остаток оставляет/размещает на складе."""
    unit = _get_storable_unit(db, payload.donor_unit_id)
    if unit.status != UnitStatus.NA_KHRANENII:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Донор должен быть в статусе 'На хранении'")
    if payload.requested_width_mm >= unit.width_mm:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Запрашиваемая ширина должна быть меньше ширины донора"
        )
    if payload.production_task_line_id is not None:
        _validate_matches_task_line(db, payload.production_task_line_id, unit.material_sku, payload.requested_width_mm)

    try:
        outcome = split_lengthwise(unit, payload.requested_width_mm)
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

    spec = outcome.new_unit
    if spec is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Не удалось отделить кусок донора")

    issued_unit = MaterialUnit(
        parent_id=spec.parent_id,
        upd_number=spec.upd_number,
        pallet_number=spec.pallet_number,
        material_sku_id=spec.material_sku_id,
        width_mm=spec.width_mm,
        length_m=spec.length_m,
        status=UnitStatus.VYDAN_UCHASTKU,
        area=payload.area,
        production_task_line_id=payload.production_task_line_id,
        location_code=None,
    )
    db.add(issued_unit)
    db.flush()

    record_event(
        db,
        unit=issued_unit,
        event_type=outcome.new_unit_event.event_type,
        user_id=user.id,
        quantity_delta_m=outcome.new_unit_event.quantity_delta_m,
        to_length=outcome.new_unit_event.to_length,
    )
    record_event(
        db,
        unit=issued_unit,
        event_type=EventType.VYDACHA_UCHASTKU,
        user_id=user.id,
        quantity_delta_m=-float(issued_unit.length_m),
    )

    db.commit()

    issued_unit = _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == issued_unit.id).first()
    remainder_unit = _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == unit.id).first()

    return AtomicDonorIssueResponse(issued_unit=issued_unit, remainder_unit=remainder_unit)


@router.post("/{unit_id}/cut", response_model=MaterialUnitOut)
def cut_unit(
    unit_id: int,
    payload: CutRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("units.cut")),
) -> MaterialUnit:
    """Раскрой по длине (2.4/6.4 ТЗ) — на складе (единица ещё "На хранении",
    совмещённая резка под цельнолистовые) либо на месте у цельнолистовых на
    стеллаже Б (единица уже "Выдан участку", area=Цельнолистовые_двери).
    Отрезанный кусок точного размера уходит в производство сразу — новая
    единица не создаётся, только событие в журнале."""
    unit = _get_storable_unit(db, unit_id)
    on_site_at_tselnolistovye = unit.status == UnitStatus.VYDAN_UCHASTKU and unit.area == "tselnolistovye_dveri"
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


@router.get("/{unit_id}/return-preview", response_model=ReturnPreviewOut)
def return_preview(
    unit_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> ReturnPreviewOut:
    """Подсказка перед возвратом (раздел про возврат остатка) — сколько
    плёнки должно остаться по расчёту, до того как оператор физически
    обмерит и введёт фактическую длину в /units/{id}/return."""
    unit = _get_storable_unit(db, unit_id)
    if not unit.production_task_line_id:
        return ReturnPreviewOut(expected_return_length_m=None, good_pieces=0.0, defect_pieces=0.0)
    line = db.get(ProductionTaskLine, unit.production_task_line_id)
    good, defect = (
        db.query(
            func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
            func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0),
        )
        .filter(ProductionTaskLineReport.task_line_id == unit.production_task_line_id)
        .one()
    )
    good, defect = float(good), float(defect)
    expected = (
        compute_expected_return_length_m(float(unit.length_m), float(line.length_m), good, defect) if line else None
    )
    return ReturnPreviewOut(expected_return_length_m=expected, good_pieces=good, defect_pieces=defect)


@router.post("/{unit_id}/return", response_model=MaterialUnitOut)
def return_unit(
    unit_id: int,
    payload: ReturnRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("units.return")),
) -> MaterialUnit:
    """Возврат остатка (2.4/6.5 ТЗ) — единый процесс для всех трёх участков,
    момент решает регламент участка. Статус → На хранении, зона С, area
    очищается; окончательное место на стеллаже задаётся позже через
    /units/{id}/place."""
    unit = _get_storable_unit(db, unit_id)
    if unit.status != UnitStatus.VYDAN_UCHASTKU:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Вернуть можно только единицу, выданную участку")

    if unit.production_task_line_id:
        report_exists = (
            db.query(ProductionTaskLineReport)
            .filter(ProductionTaskLineReport.task_line_id == unit.production_task_line_id)
            .first()
        )
        if not report_exists:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Возврат рулона невозможно выполнить: мастер участка ещё не внёс отчёт о произведённых деталях и браке!",
            )

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
    area: str | None = None,
    unplaced: bool | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MaterialUnit]:
    """Поиск остатка (5.3 "Поиск остатка", 6.7 "погонаж" ТЗ) — фильтр по
    минимальной длине задаётся в метрах при конкретной ширине, не в м².

    Без явного `status` отдаёт всё, кроме списанного (2.2 раздел бэклога
    доработок — единый список материалов вместо трёх параллельных
    реализаций); мобильный «Поиск остатка» передаёт status=На_хранении
    явно, чтобы сохранить прежнее поведение "что реально доступно".

    unplaced=true (раздел про нераспределённые остатки без стеллажей) —
    единицы физически на складе (Принят/На_хранении), но без ячейки:
    зависли посреди приёмки, после возврата (адрес всегда сбрасывается,
    см. return_unit) или после резки без указанного места для остатка.
    Выдан_участку/Списан намеренно не в счёт — у них отсутствие ячейки не
    аномалия, а нормальное состояние."""
    query = _with_sku(db.query(MaterialUnit))
    if status is not None:
        query = query.filter(MaterialUnit.status == status)
    elif unplaced:
        query = query.filter(MaterialUnit.status.in_([UnitStatus.PRINYAT, UnitStatus.NA_KHRANENII]))
    else:
        query = query.filter(MaterialUnit.status != UnitStatus.SPISAN)
    if unplaced:
        query = query.filter(MaterialUnit.location_code.is_(None))
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
