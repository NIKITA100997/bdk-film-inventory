from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Query, Session

from app.core.security import require_roles
from app.db.session import get_db
from app.models.events import EventType, MaterialEvent
from app.models.inventory import InventoryScopeType, InventorySession, InventoryStatus
from app.models.storage import Rack
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.schemas.inventory import (
    CloseSessionResult,
    InventorySessionCreate,
    InventorySessionOut,
    ResolveShortageRequest,
    ScanRequest,
    ScanResult,
    ShortageOut,
)
from app.services.dictionaries import find_or_create_sku
from app.services.events import record_event
from app.services.inventory import ScanMatchKind, match_scan

router = APIRouter(prefix="/inventory-sessions", tags=["inventory"])

manage_inventory = require_roles("logist", "kladovshchik")


def _expected_units_query(db: Session, inv_session: InventorySession) -> Query:
    """Ожидаемый список (6.8 п.2 ТЗ): единицы На_хранении в границах области
    сессии, существовавшие до её открытия. При первичном внесении (пустой
    склад) список пуст сам по себе. Отсечка по created_at — иначе единицы,
    создаваемые сканами-излишками по ходу той же сессии, попадали бы в свой
    же ожидаемый список и считались бы недостачей."""
    query = db.query(MaterialUnit).filter(
        MaterialUnit.status == UnitStatus.NA_KHRANENII,
        MaterialUnit.created_at < inv_session.started_at,
    )
    if inv_session.scope_type == InventoryScopeType.RACK:
        rack = db.get(Rack, inv_session.scope_ref_id)
        if rack is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
        query = query.filter(MaterialUnit.location_code.like(f"{rack.code}-%"))
    elif inv_session.scope_type == InventoryScopeType.MATERIAL_SKU:
        query = query.filter(MaterialUnit.material_sku_id == inv_session.scope_ref_id)
    # WAREHOUSE — без дополнительного фильтра, весь склад.
    return query


def _scanned_unit_ids(db: Session, session_id: int) -> set[int]:
    """Единицы, "закрытые" сканом в этой сессии — подтверждённые/
    перемещённые (уже существовали) и излишки (только что созданы этим же
    сканом). Все три исключаются из недостач: излишек не может сам себя
    считать пропавшим только потому, что появился уже после снятия
    ожидаемого списка."""
    rows = db.execute(
        select(MaterialEvent.unit_id).where(
            MaterialEvent.inventory_session_id == session_id,
            MaterialEvent.event_type.in_(
                [
                    EventType.INVENTARIZATSIYA_PODTVERZHDENO,
                    EventType.INVENTARIZATSIYA_PEREMESHCHENO,
                    EventType.INVENTARIZATSIYA_IZLISHEK,
                ]
            ),
        )
    ).all()
    return {r[0] for r in rows}


def _get_session(db: Session, session_id: int) -> InventorySession:
    inv_session = db.get(InventorySession, session_id)
    if inv_session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Сессия не найдена")
    return inv_session


def _to_out(db: Session, inv_session: InventorySession) -> InventorySessionOut:
    expected_count = _expected_units_query(db, inv_session).count()
    scanned_count = len(_scanned_unit_ids(db, inv_session.id))
    return InventorySessionOut(
        id=inv_session.id,
        scope_type=inv_session.scope_type,
        scope_ref_id=inv_session.scope_ref_id,
        status=inv_session.status,
        started_by=inv_session.started_by,
        closed_by=inv_session.closed_by,
        started_at=inv_session.started_at,
        closed_at=inv_session.closed_at,
        expected_count=expected_count,
        scanned_count=scanned_count,
    )


@router.post("", response_model=InventorySessionOut, status_code=status.HTTP_201_CREATED)
def start_session(
    payload: InventorySessionCreate,
    db: Session = Depends(get_db),
    user: User = Depends(manage_inventory),
) -> InventorySessionOut:
    """Открыть сессию (6.8 п.1 ТЗ) — та же процедура для обычной
    инвентаризации и для первичного внесения остатков (пустой ожидаемый
    список)."""
    inv_session = InventorySession(
        scope_type=payload.scope_type,
        scope_ref_id=payload.scope_ref_id,
        status=InventoryStatus.IN_PROGRESS,
        started_by=user.id,
    )
    db.add(inv_session)
    db.commit()
    db.refresh(inv_session)
    return _to_out(db, inv_session)


@router.get("/{session_id}", response_model=InventorySessionOut)
def get_session(session_id: int, db: Session = Depends(get_db), user: User = Depends(manage_inventory)) -> InventorySessionOut:
    return _to_out(db, _get_session(db, session_id))


@router.post("/{session_id}/scan", response_model=ScanResult)
def scan(
    session_id: int,
    payload: ScanRequest,
    db: Session = Depends(get_db),
    user: User = Depends(manage_inventory),
) -> ScanResult:
    """Скан внутри сессии (6.8 п.3 ТЗ): на месте / не по адресу / излишек
    (единицы, отсутствующей в системе — тот же экран создания, что на
    приёмке, с синтетическим УПД)."""
    inv_session = _get_session(db, session_id)
    if inv_session.status != InventoryStatus.IN_PROGRESS:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Сессия уже закрыта")

    if payload.unit_id is not None:
        unit = db.get(MaterialUnit, payload.unit_id)
        if unit is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица с таким ID не найдена")
        result = match_scan(unit.location_code, payload.location_code)
        from_cell = unit.location_code
        unit.location_code = payload.location_code
        event_type = (
            EventType.INVENTARIZATSIYA_PODTVERZHDENO
            if result.kind == ScanMatchKind.CONFIRMED
            else EventType.INVENTARIZATSIYA_PEREMESHCHENO
        )
        record_event(
            db,
            unit=unit,
            event_type=event_type,
            user_id=user.id,
            from_cell=from_cell,
            to_cell=payload.location_code,
            inventory_session_id=session_id,
        )
        db.commit()
        db.refresh(unit)
        return ScanResult(outcome=result.kind.value, unit=unit)

    # Единицы с таким ID нет — излишек: создаём как при приёмке, но с
    # синтетическим УПД (2.10 ТЗ).
    sku = find_or_create_sku(
        db, material=payload.material, color=payload.color, thickness=payload.thickness, manufacturer=payload.manufacturer
    )
    synthetic_upd = f"Инвентаризация №{session_id} от {inv_session.started_at.strftime('%d.%m.%Y')}"
    unit = MaterialUnit(
        upd_number=synthetic_upd,
        pallet_number="-",
        material_sku_id=sku.id,
        width_mm=payload.width_mm,
        length_m=payload.length_m,
        status=UnitStatus.NA_KHRANENII,
        location_code=payload.location_code,
    )
    db.add(unit)
    db.flush()
    record_event(
        db,
        unit=unit,
        event_type=EventType.INVENTARIZATSIYA_IZLISHEK,
        user_id=user.id,
        quantity_delta_m=payload.length_m,
        to_length=payload.length_m,
        to_cell=payload.location_code,
        inventory_session_id=session_id,
    )
    db.commit()
    db.refresh(unit)
    return ScanResult(outcome="surplus", unit=unit)


@router.post("/{session_id}/close", response_model=CloseSessionResult)
def close_session(
    session_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(manage_inventory),
) -> CloseSessionResult:
    """Закрытие сессии (6.8 п.4 ТЗ) — отчёт по расхождениям. Недостачи не
    списываются автоматически, только фиксируются событием — решение по
    каждой через /resolve-shortage."""
    inv_session = _get_session(db, session_id)
    if inv_session.status != InventoryStatus.IN_PROGRESS:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Сессия уже закрыта")

    scanned_ids = _scanned_unit_ids(db, session_id)
    expected_units = _expected_units_query(db, inv_session).all()
    missing_units = [u for u in expected_units if u.id not in scanned_ids]

    for unit in missing_units:
        record_event(
            db,
            unit=unit,
            event_type=EventType.INVENTARIZATSIYA_NEDOSTACHA,
            user_id=user.id,
            inventory_session_id=session_id,
        )

    confirmed_count = db.execute(
        select(MaterialEvent.event_id).where(
            MaterialEvent.inventory_session_id == session_id,
            MaterialEvent.event_type == EventType.INVENTARIZATSIYA_PODTVERZHDENO,
        )
    ).all()
    moved_count = db.execute(
        select(MaterialEvent.event_id).where(
            MaterialEvent.inventory_session_id == session_id,
            MaterialEvent.event_type == EventType.INVENTARIZATSIYA_PEREMESHCHENO,
        )
    ).all()
    surplus_count = db.execute(
        select(MaterialEvent.event_id).where(
            MaterialEvent.inventory_session_id == session_id,
            MaterialEvent.event_type == EventType.INVENTARIZATSIYA_IZLISHEK,
        )
    ).all()

    inv_session.status = InventoryStatus.CLOSED
    inv_session.closed_by = user.id
    from datetime import datetime, timezone

    inv_session.closed_at = datetime.now(timezone.utc)
    db.commit()

    return CloseSessionResult(
        session=_to_out(db, inv_session),
        confirmed_count=len(confirmed_count),
        moved_count=len(moved_count),
        surplus_count=len(surplus_count),
        shortages=[
            ShortageOut(
                id=u.id, material_sku_id=u.material_sku_id, width_mm=u.width_mm, length_m=u.length_m, location_code=u.location_code
            )
            for u in missing_units
        ],
    )


@router.post("/{session_id}/resolve-shortage/{unit_id}", response_model=InventorySessionOut)
def resolve_shortage(
    session_id: int,
    unit_id: int,
    payload: ResolveShortageRequest,
    db: Session = Depends(get_db),
    user: User = Depends(manage_inventory),
) -> InventorySessionOut:
    """Решение логиста по конкретной недостаче (6.8 п.4 ТЗ): списать или
    вернуть в поиск (полку просто не обошли — единица остаётся как есть)."""
    inv_session = _get_session(db, session_id)
    unit = db.get(MaterialUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")

    if payload.action == "spisat":
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
            inventory_session_id=session_id,
        )
    elif payload.action != "vernut_v_poisk":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="action должен быть spisat или vernut_v_poisk")

    db.commit()
    return _to_out(db, inv_session)
