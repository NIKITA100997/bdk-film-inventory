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
from app.services.warehouses import area_home_warehouse_id


def add_unit_to_transfer(
    db: Session,
    unit: MaterialUnit,
    from_warehouse_id: int,
    to_warehouse_id: int,
    user_id: int,
    occurred_at: datetime | None = None,
    cutting_operation_id: int | None = None,
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
        cutting_operation_id=cutting_operation_id,
    )
    return line


def auto_transfer_if_wrong_warehouse(
    db: Session,
    area_code: str | None,
    unit: MaterialUnit,
    unit_warehouse_id: int | None,
    user_id: int,
    occurred_at: datetime | None = None,
    cutting_operation_id: int | None = None,
) -> bool:
    """Раздел про выдачу мимо хаба — раньше это был жёсткий отказ
    (assert_area_home_warehouse, "сначала переместите через Перемещения
    между складами"): оператор нередко выбирает участок, чей домашний
    склад — Фабрика, физически имея материал на Северном, и был вынужден
    отдельно идти в другой экран и повторять выдачу заново. Теперь вместо
    отказа единица сама уходит в хаб на перемещение к домашнему складу
    участка — то же самое действие, что и ручное "Отправить на другой
    склад" с карточки единицы, просто без лишнего шага. Возвращает True,
    если случился авто-перевод (вызывающий код должен остановиться на
    этом — единица уже "В_перемещении", не "Выдан_участку", дальше её
    резать/выдавать в этом же запросе нельзя)."""
    home_id = area_home_warehouse_id(db, area_code)
    if home_id is None or unit_warehouse_id is None or unit_warehouse_id == home_id:
        return False
    add_unit_to_transfer(db, unit, unit_warehouse_id, home_id, user_id, occurred_at, cutting_operation_id)
    return True


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
    внутри перемещений).

    Раздел про автоматический уход строки из очереди "Выдачи" — area
    обнуляется ЛЮБОМУ куску, входящему в перемещение (add_unit_to_transfer
    выше, независимо от того, кто её вызвал — ручная постановка в хаб или
    auto_transfer_if_wrong_warehouse/execute_cutting_recipe при выдаче
    мимо хаба), поэтому на момент приёмки area всегда пуст, даже если
    кусок физически предназначен конкретному участку. Восстанавливаем
    его из production_task_line_id (тот единственный тег, который
    пережил всю поездку без изменений) — иначе кусок, реально ожидающий
    довыдачи участку, неотличим по area от кусков, которых участок
    больше не ждёт (после return_unit), и строка задания преждевременно
    пропадала бы из очереди "Выдачи" сразу по факту приёмки на хабе, ещё
    до фактической довыдачи участку."""
    unit.status = UnitStatus.NA_KHRANENII
    unit.location_code = None
    if unit.production_task_line_id is not None:
        unit.area = unit.production_task_line.task.area
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
