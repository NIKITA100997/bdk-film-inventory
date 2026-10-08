from datetime import datetime

from sqlalchemy.orm import Session

from app.models.events import EventType, MaterialEvent
from app.models.units import MaterialUnit


def record_event(
    db: Session,
    *,
    unit: MaterialUnit,
    event_type: EventType,
    user_id: int,
    quantity_delta_m: float = 0,
    from_length: float | None = None,
    to_length: float | None = None,
    from_cell: str | None = None,
    to_cell: str | None = None,
    inventory_session_id: int | None = None,
    write_off_reason: str | None = None,
    write_off_note: str | None = None,
    expected_length_m: float | None = None,
    occurred_at: datetime | None = None,
    cutting_operation_id: int | None = None,
) -> MaterialEvent:
    """Единая точка записи в журнал (2.6 ТЗ) — вызывается сервисным слоем при
    каждой операции над MaterialUnit, не роутерами напрямую.

    occurred_at — раздел про дату операции задним числом: если не передан,
    остаётся server_default=func.now() на самой колонке (как раньше)."""
    event = MaterialEvent(
        unit_id=unit.id,
        material_sku_id=unit.material_sku_id,
        event_type=event_type,
        area=unit.area,
        user_id=user_id,
        width_mm=unit.width_mm,
        from_length=from_length,
        to_length=to_length,
        from_cell=from_cell,
        to_cell=to_cell,
        production_task_line_id=unit.production_task_line_id,
        quantity_delta_m=quantity_delta_m,
        inventory_session_id=inventory_session_id,
        write_off_reason=write_off_reason,
        write_off_note=write_off_note,
        expected_length_m=expected_length_m,
        cutting_operation_id=cutting_operation_id,
        **({"timestamp": occurred_at} if occurred_at is not None else {}),
    )
    db.add(event)
    return event


def unit_issued_since(db, unit_id: int):
    """Когда рулон/штрипс выдали участку в последний раз (08.10, штрипс
    №3264). Отчёты раньше этой отметки — от прошлых выдач: их нельзя
    засчитывать ни в «отчёт есть — можно вернуть», ни в расход текущей
    выдачи (длина рулона после возврата уже уменьшена на тот расход).
    None — выдач не было, берутся все отчёты."""
    from sqlalchemy import func

    from app.models.events import EventType, MaterialEvent

    return (
        db.query(func.max(MaterialEvent.timestamp))
        .filter(MaterialEvent.unit_id == unit_id, MaterialEvent.event_type == EventType.VYDACHA_UCHASTKU)
        .scalar()
    )
