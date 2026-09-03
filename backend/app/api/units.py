import datetime as dt
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi import Query as FastAPIQuery
from sqlalchemy import func, or_
from sqlalchemy.orm import Query, Session, joinedload

from app.core.security import get_current_user, get_permission_codes, require_permission
from app.db.session import get_db
from app.models.abc import CalcSettings, WidthAbcClass, WidthClass
from app.models.cutting_operations import CuttingOperation
from app.models.dictionaries import MaterialSku
from app.models.events import EventType, MaterialEvent
from app.models.production import ProductionTaskLine, ProductionTaskLineReport
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.models.write_off_reasons import WriteOffReasonEntry
from app.schemas.deletion_requests import DeleteResultOut
from app.schemas.units import (
    CutRequest,
    CuttingOperationOut,
    CuttingOperationPieceOut,
    CuttingPlanDonorOut,
    CuttingPlanOut,
    CuttingPlanRequest,
    CuttingRecipeRequest,
    CuttingRecipeResponse,
    CuttingRecipeResultPiece,
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
    UnitEventOut,
    WriteOffRequest,
)
from app.services.cutting_plan import DonorCandidate, build_cutting_plan
from app.services.cutting_undo import check_undo_eligibility, has_undo_permission, undo_cutting_operation
from app.services.deletion_requests import request_deletion
from app.services.dictionaries import find_or_create_sku, find_sku
from app.services.events import record_event
from app.services.placement import rule_matches, rules_for_location
from app.services.production import calc_default_strip_width, compute_expected_return_length_m
from app.services.purchasing import auto_close_on_receipt
from app.services.splitting import (
    cut_to_length,
    donor_remainder_write_off_m,
    split_by_length,
    split_lengthwise_multi,
)
from app.services.warehouse_transfers import add_unit_to_transfer, auto_transfer_if_wrong_warehouse
from app.services.warehouses import (
    area_home_warehouse_id,
    filter_by_warehouse,
    rack_warehouse_names,
    resolve_warehouse_id,
    resolve_warehouse_name,
)

router = APIRouter(prefix="/units", tags=["units"])


def _validate_matches_task_line(
    db: Session,
    task_line_id: int,
    sku: MaterialSku,
    width_mm: float,
    *,
    allow_strip_width_override: bool = False,
    allow_material_override: bool = False,
) -> None:
    """Строгое соответствие плёнки строке задания (раздел про строгую
    выдачу) — склад не может выдать не ту номенклатуру/ширину, что
    требует конкретная строка задания, даже если оператор вручную поменял
    поля после автоподстановки на фронте. И ширина, и материал — пока идёт
    тестирование размеров и не хватает нужной номенклатуры на складе,
    разрешаем поправить прямо здесь (allow_strip_width_override/
    allow_material_override, из override_strip_width/override_material на
    запросе + права production_tasks.manage у вызывающего) вместо отказа:
    запоминаем исправление в самой строке задания, чтобы следующая
    выдача/резка по этой же строке не упёрлась в то же расхождение снова —
    см. sync_part_to_task_lines для похожего сценария со стороны
    справочника деталей."""
    line = db.get(ProductionTaskLine, task_line_id)
    if line is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Строка задания не найдена")
    if (sku.material_id, sku.color_id, sku.thickness_id) != (line.material_id, line.color_id, line.thickness_id):
        if not allow_material_override:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Плёнка не соответствует материалу строки задания")
        line.material_id = sku.material_id
        line.color_id = sku.color_id
        line.thickness_id = sku.thickness_id
    expected_w = (
        float(line.strip_width_mm)
        if line.strip_width_mm is not None
        else calc_default_strip_width(line.part_name, float(line.width_mm))
    )
    if abs(width_mm - expected_w) > 0.01:
        if not allow_strip_width_override:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Ширина не соответствует строке задания: нужно {expected_w} мм, запрошено {width_mm} мм",
            )
        line.strip_width_mm = width_mm


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
            is_strip=payload.is_strip,
            status=UnitStatus.NA_KHRANENII if payload.location_code else UnitStatus.PRINYAT,
            location_code=payload.location_code,
        )
        db.add(unit)
        db.flush()  # получить unit.id для события
        if payload.occurred_at is not None:
            # Раздел про дату операции задним числом — приход и рождение
            # единицы (created_at) это один и тот же реальный момент,
            # иначе задним числом принятый рулон путал бы FIFO/донор-логику
            # (issue_to_area считает "дней на складе" от created_at).
            unit.created_at = payload.occurred_at
        record_event(
            db,
            unit=unit,
            event_type=EventType.PRIHOD,
            user_id=user.id,
            quantity_delta_m=payload.length_m,
            to_length=payload.length_m,
            to_cell=payload.location_code,
            occurred_at=payload.occurred_at,
        )
        created.append(unit)
    auto_close_on_receipt(
        db, material_id=sku.material_id, color_id=sku.color_id, thickness_id=sku.thickness_id
    )
    db.commit()
    ids = [u.id for u in created]
    return _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id.in_(ids)).all()


def _cutting_operation_out(db: Session, op: CuttingOperation, user: User) -> CuttingOperationOut:
    sku = db.get(MaterialSku, op.donor_material_sku_id)
    pieces = (
        db.query(MaterialUnit).filter(MaterialUnit.created_by_cutting_operation_id == op.id).all()
    )
    if not has_undo_permission(op, user):
        can_undo, reason = False, "Недостаточно прав для отмены этой резки"
    else:
        can_undo, reason = check_undo_eligibility(db, op)
    performer = db.get(User, op.user_id)
    undone_performer = db.get(User, op.undone_by) if op.undone_by is not None else None
    return CuttingOperationOut(
        id=op.id,
        donor_unit_id=op.donor_unit_id,
        donor_material_sku=sku,
        donor_width_before_mm=op.donor_width_before_mm,
        donor_length_before_m=op.donor_length_before_m,
        donor_status_before=op.donor_status_before,
        donor_width_after_mm=op.donor_width_after_mm,
        donor_length_after_m=op.donor_length_after_m,
        donor_status_after=op.donor_status_after,
        donor_auto_written_off=op.donor_auto_written_off,
        length_precut_m=op.length_precut_m,
        occurred_at=op.occurred_at,
        created_at=op.created_at,
        user_id=op.user_id,
        user_name=performer.full_name if performer else f"№{op.user_id}",
        undone_at=op.undone_at,
        undone_by=op.undone_by,
        undone_by_name=undone_performer.full_name if undone_performer else None,
        resulting_pieces=[CuttingOperationPieceOut.model_validate(p) for p in pieces],
        can_undo=can_undo,
        cannot_undo_reason=reason,
    )


# ВАЖНО: этот и следующий роут — ДО @router.get("/{unit_id}") ниже. FastAPI
# сопоставляет путь чисто по количеству сегментов и порядку регистрации, а
# не по типу параметра ({unit_id} — обычная строка на уровне Starlette-роута,
# int только на уровне валидации ПОСЛЕ выбора роута) — значит однoсегментный
# GET "/cutting-operations" обязан идти раньше однoсегментного GET
# "/{unit_id}", иначе тот перехватывает запрос первым и падает 422
# ("cutting-operations" не парсится как int), до этого роута очередь вообще
# не доходит. Найдено живой Playwright-проверкой, не только чтением кода.
@router.get("/cutting-operations", response_model=list[CuttingOperationOut])
def list_cutting_operations(
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("units.issue")),
    date_from: dt.date | None = FastAPIQuery(default=None),
    date_to: dt.date | None = FastAPIQuery(default=None),
    donor_unit_id: int | None = FastAPIQuery(default=None),
    material_sku_id: int | None = FastAPIQuery(default=None),
    include_undone: bool = FastAPIQuery(default=False),
    limit: int = FastAPIQuery(default=50, le=200),
    offset: int = FastAPIQuery(default=0),
) -> list[CuttingOperationOut]:
    """Журнал резок — вкладка «История резки» в «Заготовках» (раздел про
    отмену резки). По умолчанию последние 7 дней и только ещё не отменённые
    — этот экран для оперативной работы склада, не для архивного отчёта."""
    query = db.query(CuttingOperation)
    if date_from is None and date_to is None:
        date_from = (datetime.now(timezone.utc) - dt.timedelta(days=7)).date()
    if date_from is not None:
        query = query.filter(func.date(CuttingOperation.created_at) >= date_from)
    if date_to is not None:
        query = query.filter(func.date(CuttingOperation.created_at) <= date_to)
    if donor_unit_id is not None:
        query = query.filter(CuttingOperation.donor_unit_id == donor_unit_id)
    if material_sku_id is not None:
        query = query.filter(CuttingOperation.donor_material_sku_id == material_sku_id)
    if not include_undone:
        query = query.filter(CuttingOperation.undone_at.is_(None))
    ops = query.order_by(CuttingOperation.created_at.desc()).offset(offset).limit(limit).all()
    return [_cutting_operation_out(db, op, user) for op in ops]


@router.post("/cutting-operations/{operation_id}/undo", response_model=MaterialUnitOut)
def undo_cutting_operation_endpoint(
    operation_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MaterialUnitOut:
    op = db.get(CuttingOperation, operation_id)
    if op is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Операция резки не найдена")
    if not has_undo_permission(op, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Недостаточно прав для отмены этой резки")
    can_undo, reason = check_undo_eligibility(db, op)
    if not can_undo:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=reason)
    donor = undo_cutting_operation(db, op, user)
    db.commit()
    return _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == donor.id).first()


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
        occurred_at=payload.occurred_at,
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
        occurred_at=payload.occurred_at,
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
        can_override_task_line_spec = user.is_superuser or "production_tasks.manage" in get_permission_codes(user)
        _validate_matches_task_line(
            db,
            payload.production_task_line_id,
            unit.material_sku,
            float(unit.width_mm),
            allow_strip_width_override=payload.override_strip_width and can_override_task_line_spec,
            allow_material_override=payload.override_material and can_override_task_line_spec,
        )
    unit_warehouse_id = resolve_warehouse_id(db, unit.location_code)
    # Сохраняем привязку к строке задания даже при перенаправлении в хаб
    # (ниже) — чтобы после приёмки на другом складе было видно, для какого
    # задания эта единица предназначена, не только "куда-то на перемещение".
    unit.production_task_line_id = payload.production_task_line_id
    if auto_transfer_if_wrong_warehouse(db, payload.area, unit, unit_warehouse_id, user.id, payload.occurred_at):
        db.commit()
        return _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == unit_id).first()
    from_cell = unit.location_code
    unit.status = UnitStatus.VYDAN_UCHASTKU
    unit.area = payload.area
    unit.location_code = None
    record_event(
        db,
        unit=unit,
        event_type=EventType.VYDACHA_UCHASTKU,
        user_id=user.id,
        quantity_delta_m=-float(unit.length_m),
        from_cell=from_cell,
        occurred_at=payload.occurred_at,
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

    # Раздел про выдачу мимо хаба — площадка с домашним складом (Северный/
    # Фабрика) ищет остаток только на своём складе, иначе очередь находила
    # бы "совпадение", физически лежащее на другом складе, а сама выдача
    # всё равно упёрлась бы в assert_area_home_warehouse ниже.
    home_id = area_home_warehouse_id(db, payload.area)

    exact = (
        filter_by_warehouse(
            db.query(MaterialUnit).filter(
                MaterialUnit.status == UnitStatus.NA_KHRANENII,
                MaterialUnit.material_sku_id == sku.id,
                MaterialUnit.width_mm == payload.width_mm,
                MaterialUnit.length_m >= payload.length_m,
            ),
            MaterialUnit.location_code,
            db,
            home_id,
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
            occurred_at=payload.occurred_at,
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
            filter_by_warehouse(
                db.query(MaterialUnit).filter(
                    MaterialUnit.status == UnitStatus.NA_KHRANENII,
                    MaterialUnit.material_sku_id == sku.id,
                    MaterialUnit.width_mm.in_(eligible_widths),
                    MaterialUnit.length_m >= payload.length_m,
                ),
                MaterialUnit.location_code,
                db,
                home_id,
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
        warehouse_name = resolve_warehouse_name(rack_warehouse_names(db), donor_unit.location_code)
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
                warehouse_name=warehouse_name,
            ),
        )

    # Раздел про выдачу мимо хаба — на своём складе ничего не нашлось; если
    # площадка вообще ограничена складом (home_id задан), проверяем налегке,
    # не лежит ли подходящий остаток/донор на другом складе, чтобы не
    # отправлять оператора сразу в "заявку на закупку" материала, который
    # физически уже есть, просто не там.
    elsewhere_warehouse_name = None
    if home_id is not None:
        elsewhere_unit = (
            db.query(MaterialUnit)
            .filter(
                MaterialUnit.status == UnitStatus.NA_KHRANENII,
                MaterialUnit.material_sku_id == sku.id,
                MaterialUnit.length_m >= payload.length_m,
                (MaterialUnit.width_mm == payload.width_mm) | (MaterialUnit.width_mm.in_(eligible_widths)),
            )
            .order_by(MaterialUnit.created_at.asc())
            .first()
        )
        if elsewhere_unit is not None:
            elsewhere_warehouse_name = resolve_warehouse_name(rack_warehouse_names(db), elsewhere_unit.location_code)

    return IssueResult(outcome="not_found", elsewhere_warehouse_name=elsewhere_warehouse_name)


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
        return CuttingPlanOut(
            donor=None, covered_widths_mm=[], uncovered_widths_mm=payload.needed_widths_mm, waste_mm=0.0, covered_indices=[]
        )

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
        covered_indices=list(plan.covered_indices),
    )


def _cutting_recipe_required_permissions(payload: CuttingRecipeRequest) -> set[str]:
    """Права под конкретно запрошенные шаги резки (раздел про единую форму
    резки) — не Depends(require_permission(...)) с его OR-семантикой
    (require_permission ниже в core/security.py — "любое из перечисленных"),
    здесь нужно AND: пользователь должен иметь ВСЕ права под факт
    запрошенных назначений, не любое одно. Подтверждено разбором реальных
    ролей в БД — есть роль только с units.cut+units.return, без
    split/issue, для персонала на площадке."""
    permission_for_kind = {
        "discard": "units.cut",
        "keep": "units.split",
        "issue": "units.issue",
        "transfer": "warehouse_transfers.manage",
    }
    required: set[str] = set()
    if payload.length_destination is not None:
        required.add(permission_for_kind[payload.length_destination.kind])
    for w in payload.width_cuts:
        required.add(permission_for_kind[w.destination.kind])
    return required


@router.post("/cutting-recipe", response_model=CuttingRecipeResponse)
def execute_cutting_recipe(
    payload: CuttingRecipeRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CuttingRecipeResponse:
    """Единая резка донора (раздел про объединение резки в одну форму) —
    заменяет /split, /split-length, /issue-donor-atomic,
    /cutting-plan/execute одним атомарным запросом: опциональный отрез по
    длине на всю ширину донора (оставить на складе/выдать участку/списать
    сразу), затем ноль и более кусков по ширине из остатка (оставить на
    складе/выдать участку). Автосписание остатка донора тоньше порога
    полезной ширины в конце — donor_remainder_write_off_m, раньше
    применявшаяся только в execute_cutting_plan, теперь единственное
    место резки вообще, что и чинит баг "штрипсы-огрызки не списывались
    сами" (реальные данные — 30 ручных списаний причиной 'other', ни
    одного автоматического 'cutting_waste')."""
    if payload.length_precut_m is None and not payload.width_cuts:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Нужен хотя бы один отрез")
    if payload.length_precut_m is not None and payload.length_destination is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Не указано назначение отреза по длине"
        )
    for w in payload.width_cuts:
        if w.destination.kind == "discard":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Кусок по ширине нельзя сразу списать — просто не режьте эту ширину",
            )
    if payload.length_destination is not None and payload.length_destination.kind == "issue" and not payload.length_destination.area:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Не указан участок для отреза по длине")
    for w in payload.width_cuts:
        if w.destination.kind == "issue" and not w.destination.area:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Не указан участок для одного из кусков")
    if payload.length_destination is not None and payload.length_destination.kind == "transfer" and not payload.length_destination.to_warehouse_id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Не указан склад назначения для отреза по длине")
    for w in payload.width_cuts:
        if w.destination.kind == "transfer" and not w.destination.to_warehouse_id:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Не указан склад назначения для одного из кусков")

    required = _cutting_recipe_required_permissions(payload)
    if not user.is_superuser and not required <= get_permission_codes(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Недостаточно прав для одного из запрошенных действий резки"
        )

    donor = _get_storable_unit(db, payload.donor_unit_id)
    if payload.width_cuts:
        if donor.status != UnitStatus.NA_KHRANENII:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Резать по ширине можно только единицу на хранении")
    elif donor.status not in (UnitStatus.NA_KHRANENII, UnitStatus.VYDAN_UCHASTKU):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Раскрой по длине доступен только на складе или у участка, которому единица выдана",
        )

    # Раздел про отмену резки — заголовок операции создаём здесь, до любых
    # мутаций донора, чтобы снимок "до" был честным; id нужен уже для
    # первого record_event ниже, поэтому flush сразу.
    occurred_at_value = payload.occurred_at or datetime.now(timezone.utc)
    cutting_op = CuttingOperation(
        donor_unit_id=donor.id,
        donor_material_sku_id=donor.material_sku_id,
        donor_width_before_mm=donor.width_mm,
        donor_length_before_m=donor.length_m,
        donor_status_before=donor.status.value,
        donor_location_code_before=donor.location_code,
        donor_width_after_mm=donor.width_mm,
        donor_length_after_m=donor.length_m,
        donor_status_after=donor.status.value,
        length_precut_m=payload.length_precut_m,
        required_permissions=",".join(sorted(required)),
        occurred_at=occurred_at_value,
        user_id=user.id,
    )
    db.add(cutting_op)
    db.flush()

    # Провалидировать все строки заданий заранее, до любых мутаций доноров
    # (тот же порядок, что уже в execute_cutting_plan/issue_donor_atomic).
    length_line: ProductionTaskLine | None = None
    if payload.length_destination is not None and payload.length_destination.production_task_line_id is not None:
        _validate_matches_task_line(
            db, payload.length_destination.production_task_line_id, donor.material_sku, float(donor.width_mm)
        )
        length_line = db.get(ProductionTaskLine, payload.length_destination.production_task_line_id)

    can_override_task_line_spec = user.is_superuser or "production_tasks.manage" in get_permission_codes(user)
    width_lines: dict[int, ProductionTaskLine] = {}
    for w in payload.width_cuts:
        if w.destination.production_task_line_id is not None:
            _validate_matches_task_line(
                db,
                w.destination.production_task_line_id,
                donor.material_sku,
                w.width_mm,
                allow_strip_width_override=w.override_strip_width and can_override_task_line_spec,
                allow_material_override=w.override_material and can_override_task_line_spec,
            )
            width_lines[w.destination.production_task_line_id] = db.get(
                ProductionTaskLine, w.destination.production_task_line_id
            )

    # Раздел про перемещение между складами — склад отправления берём с
    # донора один раз, до любых мутаций его адреса, если хоть один шаг
    # уходит "на перемещение" (add_unit_to_transfer сама переведёт
    # получившийся кусок в В_перемещении).
    has_transfer_step = (payload.length_destination is not None and payload.length_destination.kind == "transfer") or any(
        w.destination.kind == "transfer" for w in payload.width_cuts
    )
    donor_warehouse_id: int | None = None
    if has_transfer_step:
        donor_warehouse_id = resolve_warehouse_id(db, donor.location_code)
        if donor_warehouse_id is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Не удалось определить склад отправления для донора"
            )

    length_result_id: int | None = None

    if payload.length_precut_m is not None:
        dest = payload.length_destination
        if dest.kind == "discard":
            try:
                outcome = cut_to_length(donor, payload.length_precut_m, remainder_location=dest.location_code)
            except ValueError as e:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
            donor.width_mm = outcome.parent_width_mm
            donor.length_m = outcome.parent_length_m
            donor.status = outcome.parent_status
            record_event(
                db,
                unit=donor,
                event_type=outcome.parent_event.event_type,
                user_id=user.id,
                quantity_delta_m=outcome.parent_event.quantity_delta_m,
                from_length=outcome.parent_event.from_length,
                to_length=outcome.parent_event.to_length,
                to_cell=outcome.parent_event.to_cell,
                occurred_at=payload.occurred_at,
                cutting_operation_id=cutting_op.id,
            )
        else:
            try:
                outcome = split_by_length(donor, payload.length_precut_m, new_unit_location=dest.location_code)
            except ValueError as e:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
            donor.length_m = outcome.parent_length_m
            record_event(
                db,
                unit=donor,
                event_type=outcome.parent_event.event_type,
                user_id=user.id,
                quantity_delta_m=outcome.parent_event.quantity_delta_m,
                from_length=outcome.parent_event.from_length,
                to_length=outcome.parent_event.to_length,
                occurred_at=payload.occurred_at,
                cutting_operation_id=cutting_op.id,
            )
            spec = outcome.new_unit
            is_issue = dest.kind == "issue"
            is_transfer = dest.kind == "transfer"
            issue_area = (length_line.task.area if length_line is not None else dest.area) if is_issue else None
            # Раздел про выдачу мимо хаба — если участок физически на
            # другом складе, чем донор, выдачу этого куска перенаправляем в
            # хаб (auto_transfer_if_wrong_warehouse ниже) вместо отказа.
            redirect_home_id = area_home_warehouse_id(db, issue_area) if is_issue else None
            donor_wh_for_issue = resolve_warehouse_id(db, donor.location_code) if is_issue else None
            if redirect_home_id is not None and (donor_wh_for_issue is None or donor_wh_for_issue == redirect_home_id):
                redirect_home_id = None
            new_unit = MaterialUnit(
                parent_id=spec.parent_id,
                upd_number=spec.upd_number,
                pallet_number=spec.pallet_number,
                material_sku_id=spec.material_sku_id,
                width_mm=spec.width_mm,
                length_m=spec.length_m,
                is_strip=donor.is_strip,
                status=UnitStatus.VYDAN_UCHASTKU if is_issue else UnitStatus.NA_KHRANENII,
                area=issue_area,
                production_task_line_id=dest.production_task_line_id if is_issue else None,
                location_code=None if (is_issue or is_transfer) else dest.location_code,
                created_by_cutting_operation_id=cutting_op.id,
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
                to_cell=None if (is_issue or is_transfer) else outcome.new_unit_event.to_cell,
                occurred_at=payload.occurred_at,
                cutting_operation_id=cutting_op.id,
            )
            if redirect_home_id is not None:
                add_unit_to_transfer(
                    db, new_unit, donor_wh_for_issue, redirect_home_id, user.id, payload.occurred_at,
                    cutting_operation_id=cutting_op.id,
                )
            elif is_issue:
                record_event(
                    db,
                    unit=new_unit,
                    event_type=EventType.VYDACHA_UCHASTKU,
                    user_id=user.id,
                    quantity_delta_m=-float(new_unit.length_m),
                    occurred_at=payload.occurred_at,
                    cutting_operation_id=cutting_op.id,
                )
            elif is_transfer:
                add_unit_to_transfer(
                    db, new_unit, donor_warehouse_id, dest.to_warehouse_id, user.id, payload.occurred_at,
                    cutting_operation_id=cutting_op.id,
                )
            length_result_id = new_unit.id

    width_result_ids: list[tuple[int, bool]] = []

    if payload.width_cuts:
        if float(donor.length_m) <= 0:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="После отреза по длине у донора не осталось длины для резки по ширине"
            )
        try:
            outcome = split_lengthwise_multi(donor, [w.width_mm for w in payload.width_cuts])
        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))

        donor.width_mm = outcome.parent_width_mm
        donor.length_m = outcome.parent_length_m
        record_event(
            db,
            unit=donor,
            event_type=outcome.parent_event.event_type,
            user_id=user.id,
            quantity_delta_m=outcome.parent_event.quantity_delta_m,
            from_length=outcome.parent_event.from_length,
            to_length=outcome.parent_event.to_length,
            occurred_at=payload.occurred_at,
            cutting_operation_id=cutting_op.id,
        )

        expected_length_m = float(donor.length_m)
        tolerance = max(0.1, expected_length_m * 0.05)

        for w, spec, new_unit_event in zip(payload.width_cuts, outcome.new_units, outcome.new_unit_events):
            dest = w.destination
            is_issue = dest.kind == "issue"
            is_transfer = dest.kind == "transfer"
            line = width_lines.get(dest.production_task_line_id) if dest.production_task_line_id else None
            actual_length_m = w.actual_length_m if (is_issue and w.actual_length_m is not None) else expected_length_m
            issue_area = (line.task.area if line is not None else dest.area) if is_issue else None
            # Раздел про выдачу мимо хаба — см. аналогичный комментарий у
            # отреза по длине выше.
            redirect_home_id = area_home_warehouse_id(db, issue_area) if is_issue else None
            donor_wh_for_issue = resolve_warehouse_id(db, donor.location_code) if is_issue else None
            if redirect_home_id is not None and (donor_wh_for_issue is None or donor_wh_for_issue == redirect_home_id):
                redirect_home_id = None
            new_unit = MaterialUnit(
                parent_id=spec.parent_id,
                upd_number=spec.upd_number,
                pallet_number=spec.pallet_number,
                material_sku_id=spec.material_sku_id,
                width_mm=spec.width_mm,
                length_m=actual_length_m if is_issue else spec.length_m,
                is_strip=True,
                status=UnitStatus.VYDAN_UCHASTKU if is_issue else UnitStatus.NA_KHRANENII,
                area=issue_area,
                production_task_line_id=dest.production_task_line_id if is_issue else None,
                location_code=None if (is_issue or is_transfer) else dest.location_code,
                created_by_cutting_operation_id=cutting_op.id,
            )
            db.add(new_unit)
            db.flush()
            record_event(
                db,
                unit=new_unit,
                event_type=new_unit_event.event_type,
                user_id=user.id,
                quantity_delta_m=new_unit_event.quantity_delta_m,
                to_length=expected_length_m if is_issue else new_unit_event.to_length,
                to_cell=None if (is_issue or is_transfer) else new_unit_event.to_cell,
                occurred_at=payload.occurred_at,
                cutting_operation_id=cutting_op.id,
            )
            discrepancy_flagged = False
            if redirect_home_id is not None:
                add_unit_to_transfer(
                    db, new_unit, donor_wh_for_issue, redirect_home_id, user.id, payload.occurred_at,
                    cutting_operation_id=cutting_op.id,
                )
            elif is_issue:
                discrepancy_flagged = abs(actual_length_m - expected_length_m) > tolerance
                record_event(
                    db,
                    unit=new_unit,
                    event_type=EventType.VYDACHA_UCHASTKU,
                    user_id=user.id,
                    quantity_delta_m=-actual_length_m,
                    to_length=actual_length_m,
                    expected_length_m=expected_length_m,
                    occurred_at=payload.occurred_at,
                    cutting_operation_id=cutting_op.id,
                )
            elif is_transfer:
                add_unit_to_transfer(
                    db, new_unit, donor_warehouse_id, dest.to_warehouse_id, user.id, payload.occurred_at,
                    cutting_operation_id=cutting_op.id,
                )
            width_result_ids.append((new_unit.id, discrepancy_flagged))

    settings = db.get(CalcSettings, 1)
    min_useful_width = float(settings.min_useful_width_mm) if settings else 30.0
    write_off_m = donor_remainder_write_off_m(float(donor.width_mm), float(donor.length_m), min_useful_width)
    if write_off_m is not None:
        donor.status = UnitStatus.SPISAN
        donor.location_code = None
        record_event(
            db,
            unit=donor,
            event_type=EventType.SPISANIE,
            user_id=user.id,
            quantity_delta_m=-write_off_m,
            from_length=float(donor.length_m),
            to_length=0,
            write_off_reason="cutting_waste",
            occurred_at=payload.occurred_at,
            cutting_operation_id=cutting_op.id,
        )
        cutting_op.donor_auto_written_off = True

    cutting_op.donor_width_after_mm = donor.width_mm
    cutting_op.donor_length_after_m = donor.length_m
    cutting_op.donor_status_after = donor.status.value

    db.commit()

    length_result = None
    if length_result_id is not None:
        length_result = CuttingRecipeResultPiece(
            unit=_with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == length_result_id).first()
        )
    width_results = [
        CuttingRecipeResultPiece(
            unit=_with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == uid).first(), discrepancy_flagged=flagged
        )
        for uid, flagged in width_result_ids
    ]
    donor_remainder = _with_sku(db.query(MaterialUnit)).filter(MaterialUnit.id == donor.id).first()

    return CuttingRecipeResponse(length_result=length_result, width_results=width_results, donor_remainder=donor_remainder)


@router.post("/{unit_id}/cut", response_model=MaterialUnitOut)
def cut_unit(
    unit_id: int,
    payload: CutRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("units.cut")),
) -> MaterialUnit:
    """Раскрой по длине (2.4/6.4 ТЗ) — на складе (единица ещё "На хранении")
    либо на месте у участка, которому единица уже выдана ("Выдан участку",
    любой участок — напр. списание фактически израсходованного метража во
    время смены). Отрезанный кусок точного размера уходит в производство
    сразу — новая единица не создаётся, только событие в журнале."""
    unit = _get_storable_unit(db, unit_id)
    if unit.status not in (UnitStatus.NA_KHRANENII, UnitStatus.VYDAN_UCHASTKU):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Раскрой по длине доступен только на складе или у участка, которому единица выдана",
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
        occurred_at=payload.occurred_at,
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
        .filter(
            ProductionTaskLineReport.task_line_id == unit.production_task_line_id,
            # Раздел про цифровой аналог "Ежедневки" — на строке может
            # смениться несколько рулонов (пилот: окутка царговых), у
            # каждого свои отчёты (material_unit_id). Берём отчёты именно
            # этого рулона плюс старые без привязки к рулону вообще (там,
            # где выбор рулона не включён — весь расход всё ещё общий на
            # строку, как раньше).
            or_(ProductionTaskLineReport.material_unit_id == unit_id, ProductionTaskLineReport.material_unit_id.is_(None)),
        )
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
        occurred_at=payload.occurred_at,
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
    warehouse_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MaterialUnitOut]:
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
    аномалия, а нормальное состояние.

    warehouse_id (раздел про остатки по конкретному складу) — тот же
    приём, что уже в отчётах (filter_by_warehouse, префикс location_code
    относительно Rack.code); единицы, выданные участку или ещё без ячейки,
    закономерно не попадают ни под какой склад."""
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
    query = filter_by_warehouse(query, MaterialUnit.location_code, db, warehouse_id)
    units = query.order_by(MaterialUnit.width_mm.asc(), MaterialUnit.length_m.desc()).limit(200).all()

    # Название склада — не прямое поле единицы (только префикс location_code
    # относительно Rack.code), разрешаем один раз для всех стеллажей и
    # сопоставляем в python, тот же приём, что уже даёт rackForLocation() на
    # фронте (MaterialsExplorer.tsx).
    names = rack_warehouse_names(db)
    return [
        MaterialUnitOut.model_validate(u).model_copy(update={"warehouse_name": resolve_warehouse_name(names, u.location_code)})
        for u in units
    ]
