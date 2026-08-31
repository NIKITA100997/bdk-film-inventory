from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.storage import Warehouse
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.models.warehouse_transfers import (
    STATUS_OTPRAVLENO,
    STATUS_PRINYATO,
    STATUS_SOBIRAETSYA,
    WarehouseTransfer,
    WarehouseTransferLine,
)
from app.schemas.warehouse_transfers import (
    AddUnitToTransferRequest,
    ReceiveTransferLineRequest,
    WarehouseTransferLineOut,
    WarehouseTransferOut,
)
from app.services.warehouse_transfers import add_unit_to_transfer, receive_transfer_line
from app.services.warehouses import resolve_warehouse_id

router = APIRouter(prefix="/warehouse-transfers", tags=["warehouse-transfers"])

manage_transfers = require_permission("warehouse_transfers.manage")


def _lines_for(db: Session, transfer_id: int) -> list[WarehouseTransferLine]:
    return (
        db.query(WarehouseTransferLine)
        .options(joinedload(WarehouseTransferLine.unit).joinedload(MaterialUnit.material_sku))
        .filter(WarehouseTransferLine.transfer_id == transfer_id)
        .all()
    )


def _transfer_out(db: Session, transfer: WarehouseTransfer, lines: list[WarehouseTransferLine]) -> WarehouseTransferOut:
    names = {w.id: w.name for w in db.query(Warehouse).all()}
    return WarehouseTransferOut(
        id=transfer.id,
        from_warehouse_id=transfer.from_warehouse_id,
        from_warehouse_name=names.get(transfer.from_warehouse_id, "?"),
        to_warehouse_id=transfer.to_warehouse_id,
        to_warehouse_name=names.get(transfer.to_warehouse_id, "?"),
        status=transfer.status,
        note=transfer.note,
        created_at=transfer.created_at,
        shipped_at=transfer.shipped_at,
        received_at=transfer.received_at,
        lines=[WarehouseTransferLineOut.model_validate(line) for line in lines],
    )


@router.get("", response_model=list[WarehouseTransferOut])
def list_warehouse_transfers(
    status_filter: str | None = None,
    to_warehouse_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WarehouseTransferOut]:
    query = db.query(WarehouseTransfer)
    if status_filter is not None:
        query = query.filter(WarehouseTransfer.status == status_filter)
    if to_warehouse_id is not None:
        query = query.filter(WarehouseTransfer.to_warehouse_id == to_warehouse_id)
    transfers = query.order_by(WarehouseTransfer.created_at.desc()).all()

    line_query = (
        db.query(WarehouseTransferLine)
        .options(joinedload(WarehouseTransferLine.unit).joinedload(MaterialUnit.material_sku))
        .filter(WarehouseTransferLine.transfer_id.in_([t.id for t in transfers]))
    ) if transfers else None
    lines_by_transfer: dict[int, list[WarehouseTransferLine]] = {}
    if line_query is not None:
        for line in line_query.all():
            lines_by_transfer.setdefault(line.transfer_id, []).append(line)

    return [_transfer_out(db, t, lines_by_transfer.get(t.id, [])) for t in transfers]


@router.post("/add-unit", response_model=WarehouseTransferOut)
def add_unit_to_transfer_endpoint(
    payload: AddUnitToTransferRequest,
    db: Session = Depends(get_db),
    user: User = Depends(manage_transfers),
) -> WarehouseTransferOut:
    """Добавить единицу в хаб на перемещение (раздел про объединение резки
    и ручной постановки в хаб — вызывается и напрямую с этого эндпоинта
    для уже лежащей на складе единицы, и изнутри execute_cutting_recipe
    для только что нарезанного куска)."""
    unit = db.get(MaterialUnit, payload.unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")
    if unit.status != UnitStatus.NA_KHRANENII:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="В перемещение можно добавить только единицу на хранении")

    from_warehouse_id = resolve_warehouse_id(db, unit.location_code)
    if from_warehouse_id is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Не удалось определить склад отправления — у единицы нет адреса")
    if from_warehouse_id == payload.to_warehouse_id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Склад назначения совпадает со складом отправления")

    line = add_unit_to_transfer(db, unit, from_warehouse_id, payload.to_warehouse_id, user.id, payload.occurred_at)
    transfer = db.get(WarehouseTransfer, line.transfer_id)
    if payload.note:
        transfer.note = payload.note
    db.commit()

    lines = _lines_for(db, transfer.id)
    return _transfer_out(db, transfer, lines)


@router.post("/{transfer_id}/lines/{line_id}/remove", response_model=WarehouseTransferOut)
def remove_transfer_line(
    transfer_id: int,
    line_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(manage_transfers),
) -> WarehouseTransferOut:
    """Убрать единицу из хаба — отмена, единица возвращается На_хранении
    без адреса (попадёт в "Стеллажи → Без места", как и любая другая
    неразмещённая единица)."""
    transfer = db.get(WarehouseTransfer, transfer_id)
    if transfer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Перемещение не найдено")
    if transfer.status != STATUS_SOBIRAETSYA:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Убрать строку можно только из ещё не отправленной партии")
    line = db.get(WarehouseTransferLine, line_id)
    if line is None or line.transfer_id != transfer_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Строка не найдена")

    unit = db.get(MaterialUnit, line.unit_id)
    unit.status = UnitStatus.NA_KHRANENII
    unit.location_code = None
    db.delete(line)
    db.commit()

    lines = _lines_for(db, transfer.id)
    return _transfer_out(db, transfer, lines)


@router.post("/{transfer_id}/ship", response_model=WarehouseTransferOut)
def ship_transfer(
    transfer_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(manage_transfers),
) -> WarehouseTransferOut:
    transfer = db.get(WarehouseTransfer, transfer_id)
    if transfer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Перемещение не найдено")
    if transfer.status != STATUS_SOBIRAETSYA:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Партия уже отправлена")
    line_count = db.query(WarehouseTransferLine).filter(WarehouseTransferLine.transfer_id == transfer_id).count()
    if line_count == 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="В партии нет ни одной единицы")

    transfer.status = STATUS_OTPRAVLENO
    transfer.shipped_at = datetime.now(timezone.utc)
    db.commit()

    lines = _lines_for(db, transfer.id)
    return _transfer_out(db, transfer, lines)


def _maybe_complete_transfer(db: Session, transfer: WarehouseTransfer) -> None:
    remaining = (
        db.query(WarehouseTransferLine)
        .filter(WarehouseTransferLine.transfer_id == transfer.id, WarehouseTransferLine.received_at.is_(None))
        .count()
    )
    if remaining == 0:
        transfer.status = STATUS_PRINYATO
        transfer.received_at = datetime.now(timezone.utc)


@router.post("/{transfer_id}/lines/{line_id}/receive", response_model=WarehouseTransferOut)
def receive_line(
    transfer_id: int,
    line_id: int,
    payload: ReceiveTransferLineRequest,
    db: Session = Depends(get_db),
    user: User = Depends(manage_transfers),
) -> WarehouseTransferOut:
    transfer = db.get(WarehouseTransfer, transfer_id)
    if transfer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Перемещение не найдено")
    if transfer.status != STATUS_OTPRAVLENO:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Принять можно только отправленную партию")
    line = db.get(WarehouseTransferLine, line_id)
    if line is None or line.transfer_id != transfer_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Строка не найдена")
    if line.received_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Строка уже принята")

    unit = db.get(MaterialUnit, line.unit_id)
    receive_transfer_line(db, line, unit, user.id, payload.occurred_at)
    _maybe_complete_transfer(db, transfer)
    db.commit()

    lines = _lines_for(db, transfer.id)
    return _transfer_out(db, transfer, lines)


@router.post("/{transfer_id}/receive-all", response_model=WarehouseTransferOut)
def receive_all_lines(
    transfer_id: int,
    payload: ReceiveTransferLineRequest,
    db: Session = Depends(get_db),
    user: User = Depends(manage_transfers),
) -> WarehouseTransferOut:
    transfer = db.get(WarehouseTransfer, transfer_id)
    if transfer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Перемещение не найдено")
    if transfer.status != STATUS_OTPRAVLENO:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Принять можно только отправленную партию")

    open_lines = (
        db.query(WarehouseTransferLine)
        .filter(WarehouseTransferLine.transfer_id == transfer_id, WarehouseTransferLine.received_at.is_(None))
        .all()
    )
    for line in open_lines:
        unit = db.get(MaterialUnit, line.unit_id)
        receive_transfer_line(db, line, unit, user.id, payload.occurred_at)
    _maybe_complete_transfer(db, transfer)
    db.commit()

    lines = _lines_for(db, transfer.id)
    return _transfer_out(db, transfer, lines)
