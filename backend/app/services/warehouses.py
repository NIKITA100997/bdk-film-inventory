from sqlalchemy import or_
from sqlalchemy.orm import Session
from sqlalchemy.sql import false

from app.models.storage import Rack, Warehouse


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


def rack_warehouse_names(db: Session) -> dict[str, str]:
    """Название склада по коду стеллажа — раньше жило инлайном только в
    api/units.py::search_units, теперь общее и для "Карточки материала"
    (get_material_card) тоже: у MaterialUnit нет прямого warehouse_id, только
    префикс location_code относительно Rack.code."""
    return {
        code: name
        for code, name in db.query(Rack.code, Warehouse.name).join(Warehouse, Rack.warehouse_id == Warehouse.id).all()
    }


def resolve_warehouse_name(names: dict[str, str], location_code: str | None) -> str | None:
    if not location_code:
        return None
    for code, name in names.items():
        if location_code.startswith(f"{code}-"):
            return name
    return None


def resolve_warehouse_id(db: Session, location_code: str | None) -> int | None:
    """Тот же приём, что resolve_warehouse_name, только возвращает id
    склада, а не имя — нужен для перемещений между складами (раздел про
    хаб на перемещение), где важен именно id (FK на warehouse), а не
    подпись для отображения."""
    if not location_code:
        return None
    for code, warehouse_id in db.query(Rack.code, Rack.warehouse_id).all():
        if location_code.startswith(f"{code}-"):
            return warehouse_id
    return None
