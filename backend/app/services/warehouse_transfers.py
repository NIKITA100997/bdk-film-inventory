"""Раздел про перемещение между складами (хаб на Северном → отправка на
Фабрику) — чистая, переиспользуемая логика, вызываемая и из
api/warehouse_transfers.py, и изнутри execute_cutting_recipe (когда
кусок режут сразу с назначением "на перемещение", без промежуточного
размещения на складе отправления)."""

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.events import EventType
from app.models.units import MaterialUnit, UnitStatus
from app.models.warehouse_transfers import (
    STATUS_SOBIRAETSYA,
    WarehouseTransfer,
    WarehouseTransferLine,
)
from app.services.events import record_event


def add_unit_to_transfer(
    db: Session,
    unit: MaterialUnit,
    from_warehouse_id: int,
    to_warehouse_id: int,
    user_id: int,
    occurred_at: datetime | None = None,
) -> WarehouseTransferLine:
    """Находит открытую (SOBIRAETSYA) партию с тем же складом отправления
    и назначения, либо создаёт новую; переводит единицу в
    В_перемещении (location_code/area обнуляются — единица больше не
    "на складе" и не "у участка", она в пути) и добавляет строку."""
    transfer = (
        db.query(WarehouseTransfer)
        .filter(
            WarehouseTransfer.status == STATUS_SOBIRAETSYA,
            WarehouseTransfer.from_warehouse_id == from_warehouse_id,
            WarehouseTransfer.to_warehouse_id == to_warehouse_id,
        )
        .first()
    )
    if transfer is None:
        transfer = WarehouseTransfer(
            from_warehouse_id=from_warehouse_id,
            to_warehouse_id=to_warehouse_id,
            created_by=user_id,
        )
        db.add(transfer)
        db.flush()

    from_cell = unit.location_code
    unit.status = UnitStatus.V_PEREMESHCHENII
    unit.location_code = None
    unit.area = None

    line = WarehouseTransferLine(transfer_id=transfer.id, unit_id=unit.id)
    db.add(line)
    db.flush()

    record_event(
        db,
        unit=unit,
        event_type=EventType.PEREMESHCHENIE_NACHATO,
        user_id=user_id,
        from_cell=from_cell,
        occurred_at=occurred_at,
    )
    return line


def receive_transfer_line(
    db: Session,
    line: WarehouseTransferLine,
    unit: MaterialUnit,
    user_id: int,
    occurred_at: datetime | None = None,
) -> None:
    """Приёмка одной строки на складе назначения — единица снова
    На_хранении, без ячейки (раздел про переиспользование существующего
    экрана "Стеллажи → Без места" вместо отдельной формы размещения
    внутри перемещений)."""
    unit.status = UnitStatus.NA_KHRANENII
    unit.location_code = None
    line.received_at = datetime.now(timezone.utc)

    record_event(
        db,
        unit=unit,
        event_type=EventType.PEREMESHCHENIE_PRINYATO,
        user_id=user_id,
        occurred_at=occurred_at,
    )
    # db.autoflush=False проектно (db/session.py) — без явного flush
    # последующий count() в _maybe_complete_transfer (api/warehouse_transfers.py)
    # видит устаревшее received_at IS NULL и не закрывает партию, даже
    # когда это последняя ещё не принятая строка (баг, пойманный живой
    # проверкой этого сценария).
    db.flush()
