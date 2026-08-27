from sqlalchemy import or_
from sqlalchemy.orm import Session
from sqlalchemy.sql import false

from app.models.storage import Rack


def rack_codes_for_warehouse(db: Session, warehouse_id: int) -> list[str]:
    return [code for (code,) in db.query(Rack.code).filter(Rack.warehouse_id == warehouse_id).all()]


def filter_by_warehouse(query, column, db: Session, warehouse_id: int | None):
    """Раздел про отчёты/остатки по складам отдельно — у MaterialUnit/
    MaterialEvent нет прямого warehouse_id, склад определяется только
    префиксом location_code/to_cell относительно Rack.code (Rack.warehouse_id
    — уже реальная связь, см. api/storage.py/services/placement.py).
    Единицы, выданные участку (без ячейки), в фильтр по складу закономерно
    не попадают — они физически не на складе."""
    if warehouse_id is None:
        return query
    codes = rack_codes_for_warehouse(db, warehouse_id)
    if not codes:
        return query.filter(false())
    return query.filter(or_(*[column.like(f"{code}-%") for code in codes]))
