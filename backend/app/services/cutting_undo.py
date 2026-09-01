"""Отмена резки (раздел про историю резок и отмену) — одна функция проверки
допустимости (check_undo_eligibility) переиспользуется и списком операций
("можно ли отменить" в каждой строке), и самим эндпоинтом отмены, чтобы
условия не разъезжались в двух местах. Сама отмена (undo_cutting_operation)
зеркалит delete_unit_impl (units.py) — тот же приём "жёсткая проверка,
структурная, без второго согласующего", только теперь ещё и с откатом
донора к снимку "до", а не просто удалением.

Проверка "тронули ли единицу после резки" не сверяет статус/ячейку по
отдельности (пришлось бы реконструировать "ожидаемое" значение под каждый
случай — discard/keep/issue/transfer, штрипс это или донор) — вместо этого
проверяется сам факт: есть ли у единицы события НЕ с этим cutting_operation_id,
случившиеся позже собственных событий этой резки (по event_id — авто-
инкремент, а не по timestamp, который может быть задним числом).
record_event — единая точка записи в журнал (2.6 ТЗ), поэтому любое
последующее действие (выдача, возврат, списание, инвентаризация, повторная
резка) обязательно оставляет такое событие. Единственное исключение —
отправка партии перемещения (ship_transfer/приёмка) не пишет событие на
саму единицу, поэтому для кусков "в перемещении" есть отдельная явная
проверка по WarehouseTransferLine/WarehouseTransfer."""

from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import get_permission_codes
from app.models.cutting_operations import CuttingOperation
from app.models.events import MaterialEvent
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.models.warehouse_transfers import STATUS_SOBIRAETSYA, WarehouseTransfer, WarehouseTransferLine

UNDO_WINDOW = timedelta(hours=2)


def _resulting_pieces(db: Session, op: CuttingOperation) -> list[MaterialUnit]:
    return db.query(MaterialUnit).filter(MaterialUnit.created_by_cutting_operation_id == op.id).all()


def _touched_since(db: Session, unit_id: int, op: CuttingOperation) -> bool:
    watermark = (
        db.query(func.max(MaterialEvent.event_id))
        .filter(MaterialEvent.unit_id == unit_id, MaterialEvent.cutting_operation_id == op.id)
        .scalar()
    )
    if watermark is None:
        return False
    return (
        db.query(MaterialEvent.event_id)
        .filter(MaterialEvent.unit_id == unit_id, MaterialEvent.event_id > watermark)
        .first()
        is not None
    )


def has_undo_permission(op: CuttingOperation, user: User) -> bool:
    """Отдельно от check_undo_eligibility — эндпоинт отмены должен ответить
    403, а не 409, когда дело в правах, а не в состоянии единиц."""
    if user.is_superuser:
        return True
    required = set(op.required_permissions.split(",")) if op.required_permissions else set()
    return required <= get_permission_codes(user)


def check_undo_eligibility(db: Session, op: CuttingOperation) -> tuple[bool, str | None]:
    """Возвращает (можно_отменить, причина_если_нет) — механические условия
    (время, состояние единиц), БЕЗ прав (см. has_undo_permission отдельно).
    Ничего не мутирует — безопасно вызывать и для отображения кнопки в
    списке, и перед самой отменой."""
    if op.undone_at is not None:
        performer = db.get(User, op.undone_by) if op.undone_by is not None else None
        who = performer.full_name if performer else f"№{op.undone_by}"
        return False, f"Эта резка уже отменена ранее — {who}, {op.undone_at:%d.%m.%Y %H:%M}"

    if datetime.now(timezone.utc) - op.created_at > UNDO_WINDOW:
        return False, "Резку можно отменить только в течение 2 часов после выполнения — прошло больше времени"

    donor = db.get(MaterialUnit, op.donor_unit_id)
    pieces = _resulting_pieces(db, op)

    for piece in pieces:
        transfer_line = db.query(WarehouseTransferLine).filter(WarehouseTransferLine.unit_id == piece.id).first()
        if transfer_line is not None:
            transfer = db.get(WarehouseTransfer, transfer_line.transfer_id)
            if transfer_line.received_at is not None or (transfer is not None and transfer.status != STATUS_SOBIRAETSYA):
                return False, f"Кусок №{piece.id} уже отправлен/принят в перемещении — отмена невозможна"

        if _touched_since(db, piece.id, op):
            return False, f"Кусок №{piece.id} изменился после резки (выдан, перемещён, списан или разрезан снова) — отмена невозможна"

    if donor is not None and _touched_since(db, donor.id, op):
        return False, f"Донор №{donor.id} изменился после этой резки — отмена невозможна"

    return True, None


def undo_cutting_operation(db: Session, op: CuttingOperation, user: User) -> MaterialUnit:
    """Вызывать только после успешного check_undo_eligibility. Удаляет все
    куски, рождённые этой операцией, и их события, восстанавливает донора
    к снимку "до" — той же формой, что delete_unit_impl (units.py) удаляет
    единицу целиком: раз ничего после резки её не тронуло, "терять" у неё
    нечего."""
    pieces = _resulting_pieces(db, op)
    for piece in pieces:
        transfer_line = db.query(WarehouseTransferLine).filter(WarehouseTransferLine.unit_id == piece.id).first()
        if transfer_line is not None:
            db.delete(transfer_line)
        db.query(MaterialEvent).filter(MaterialEvent.unit_id == piece.id).delete()
        db.delete(piece)

    donor = db.get(MaterialUnit, op.donor_unit_id)
    if donor is not None:
        donor.width_mm = op.donor_width_before_mm
        donor.length_m = op.donor_length_before_m
        donor.status = UnitStatus(op.donor_status_before)
        donor.location_code = op.donor_location_code_before

    db.query(MaterialEvent).filter(MaterialEvent.cutting_operation_id == op.id).delete()

    op.undone_at = datetime.now(timezone.utc)
    op.undone_by = user.id

    return donor
