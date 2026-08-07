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
) -> MaterialEvent:
    """Единая точка записи в журнал (2.6 ТЗ) — вызывается сервисным слоем при
    каждой операции над MaterialUnit, не роутерами напрямую."""
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
        order_id=unit.order_id,
        quantity_delta_m=quantity_delta_m,
    )
    db.add(event)
    return event
