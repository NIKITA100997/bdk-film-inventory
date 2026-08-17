from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.dictionaries import Color, Manufacturer, Material, MaterialSku, Thickness
from app.models.storage import MacroZoneRule, Rack, RackType, Warehouse
from app.models.units import MaterialUnit, UnitStatus
from app.schemas.storage import (
    LocationSuggestion,
    MacroZoneRuleCreate,
    MacroZoneRuleOut,
    RackCreate,
    RackOccupancyCellOut,
    RackOut,
    RackUpdate,
    WarehouseCreate,
    WarehouseOut,
    WarehouseUpdate,
)
from app.services.placement import suggest_location

router = APIRouter(tags=["storage"])

# Справочник ячеек (4.1 п.5, 4.2 ТЗ) — заводится один раз при вводе стеллажа в
# эксплуатацию, дальше расширяется по мере роста склада. Часть
# администрирования (5.6 ТЗ) — доступ только логисту/руководителю, кладовщик
# размещает по уже готовым макрозонам, но не заводит их сам.
manage_storage = require_permission("storage.manage")


@router.get("/warehouses", response_model=list[WarehouseOut])
def list_warehouses(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Warehouse]:
    return db.query(Warehouse).order_by(Warehouse.name).all()


@router.post("/warehouses", response_model=WarehouseOut, status_code=status.HTTP_201_CREATED)
def create_warehouse(
    payload: WarehouseCreate, db: Session = Depends(get_db), user=Depends(manage_storage)
) -> Warehouse:
    if db.query(Warehouse).filter(Warehouse.name == payload.name).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Склад с таким названием уже есть")
    warehouse = Warehouse(name=payload.name, address=payload.address)
    db.add(warehouse)
    db.commit()
    db.refresh(warehouse)
    return warehouse


@router.patch("/warehouses/{warehouse_id}", response_model=WarehouseOut)
def update_warehouse(
    warehouse_id: int, payload: WarehouseUpdate, db: Session = Depends(get_db), user=Depends(manage_storage)
) -> Warehouse:
    warehouse = db.get(Warehouse, warehouse_id)
    if warehouse is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Склад не найден")
    if payload.name is not None and payload.name != warehouse.name:
        if db.query(Warehouse).filter(Warehouse.name == payload.name, Warehouse.id != warehouse_id).first():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Склад с таким названием уже есть")
        warehouse.name = payload.name
    if payload.address is not None:
        warehouse.address = payload.address
    if payload.is_active is not None:
        warehouse.is_active = payload.is_active
    db.commit()
    db.refresh(warehouse)
    return warehouse


@router.get("/racks", response_model=list[RackOut])
def list_racks(
    warehouse_id: int | None = None, db: Session = Depends(get_db), user=Depends(get_current_user)
) -> list[Rack]:
    query = db.query(Rack)
    if warehouse_id is not None:
        query = query.filter(Rack.warehouse_id == warehouse_id)
    return query.order_by(Rack.code).all()


@router.get("/racks/{rack_id}/occupancy", response_model=list[RackOccupancyCellOut])
def rack_occupancy(rack_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[RackOccupancyCellOut]:
    """Схема стеллажа (объединение "Остатки"/"Номенклатура" — по итогам
    разбора продукта) — та же адресация, что и в services/placement.py
    (suggest_location), только вместо поиска одного свободного места отдаём
    всю сетку сразу, с юнитом в каждой занятой ячейке. Открыт любому
    авторизованному — это те же данные о размещении, что уже видны в
    "Остатках", просто в виде сетки, а не таблицы."""
    rack = db.get(Rack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")

    units = (
        db.query(MaterialUnit)
        .options(
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.material),
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.color),
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.thickness),
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.manufacturer),
        )
        .filter(
            MaterialUnit.location_code.like(f"{rack.code}-%"),
            MaterialUnit.status.in_([UnitStatus.NA_KHRANENII, UnitStatus.PRINYAT]),
        )
        .all()
    )
    units_by_code: dict[str, list[MaterialUnit]] = defaultdict(list)
    for u in units:
        units_by_code[u.location_code].append(u)

    capacity = (rack.strip_capacity or 1) if rack.type == RackType.STRIP else 1
    cells: list[RackOccupancyCellOut] = []
    for shelf in range(1, rack.shelf_count + 1):
        code = f"{rack.code}-{shelf:02d}"
        cells.append(RackOccupancyCellOut(shelf=shelf, location_code=code, units=units_by_code.get(code, []), capacity=capacity))
    return cells


@router.post("/racks", response_model=RackOut, status_code=status.HTTP_201_CREATED)
def create_rack(payload: RackCreate, db: Session = Depends(get_db), user=Depends(manage_storage)) -> Rack:
    if db.query(Rack).filter(Rack.code == payload.code).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Стеллаж с таким кодом уже существует")
    if db.get(Warehouse, payload.warehouse_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Склад не найден")
    rack = Rack(
        code=payload.code,
        type=payload.type,
        shelf_count=payload.shelf_count,
        strip_capacity=payload.strip_capacity,
        warehouse_id=payload.warehouse_id,
    )
    db.add(rack)
    db.commit()
    db.refresh(rack)
    return rack


@router.patch("/racks/{rack_id}", response_model=RackOut)
def update_rack(
    rack_id: int, payload: RackUpdate, db: Session = Depends(get_db), user=Depends(manage_storage)
) -> Rack:
    rack = db.get(Rack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    if payload.code is not None and payload.code != rack.code:
        if db.query(Rack).filter(Rack.code == payload.code, Rack.id != rack_id).first():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Стеллаж с таким кодом уже существует")
        rack.code = payload.code
    if payload.type is not None:
        rack.type = payload.type
    if payload.shelf_count is not None:
        rack.shelf_count = payload.shelf_count
    if payload.strip_capacity is not None:
        rack.strip_capacity = payload.strip_capacity
    if payload.warehouse_id is not None:
        if db.get(Warehouse, payload.warehouse_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Склад не найден")
        rack.warehouse_id = payload.warehouse_id
    if payload.is_active is not None:
        rack.is_active = payload.is_active
    db.commit()
    db.refresh(rack)
    return rack


@router.delete("/racks/{rack_id}/macro-zone-rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_macro_zone_rule(
    rack_id: int, rule_id: int, db: Session = Depends(get_db), user=Depends(manage_storage)
) -> None:
    rule = db.query(MacroZoneRule).filter(MacroZoneRule.id == rule_id, MacroZoneRule.rack_id == rack_id).first()
    if rule is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Правило не найдено")
    db.delete(rule)
    db.commit()


def _lookup_dict_id(db: Session, model, name_or_value: str | float | None, field: str) -> int | None:
    """Правило зонирования ссылается только на существующие значения
    справочников (4.2 ТЗ) — опечатка не должна тихо создавать новую запись."""
    if name_or_value is None:
        return None
    obj = db.query(model).filter_by(**{field: name_or_value}).first()
    if obj is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Значение «{name_or_value}» не найдено в справочнике")
    return obj.id


@router.get("/racks/{rack_id}/macro-zone-rules", response_model=list[MacroZoneRuleOut])
def list_macro_zone_rules(rack_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[MacroZoneRule]:
    return db.query(MacroZoneRule).filter(MacroZoneRule.rack_id == rack_id).order_by(MacroZoneRule.from_shelf).all()


@router.post("/racks/{rack_id}/macro-zone-rules", response_model=MacroZoneRuleOut, status_code=status.HTTP_201_CREATED)
def create_macro_zone_rule(
    rack_id: int,
    payload: MacroZoneRuleCreate,
    db: Session = Depends(get_db),
    user=Depends(manage_storage),
) -> MacroZoneRule:
    rack = db.get(Rack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    if payload.from_shelf > payload.to_shelf:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="«От полки» не может быть больше «До полки»")
    if payload.to_shelf > rack.shelf_count:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"На стеллаже {rack.shelf_count} полок — диапазон выходит за пределы",
        )

    rule = MacroZoneRule(
        rack_id=rack_id,
        from_shelf=payload.from_shelf,
        to_shelf=payload.to_shelf,
        material_id=_lookup_dict_id(db, Material, payload.material, "name"),
        color_id=_lookup_dict_id(db, Color, payload.color, "name"),
        thickness_id=_lookup_dict_id(db, Thickness, payload.thickness, "value_mm"),
        manufacturer_id=_lookup_dict_id(db, Manufacturer, payload.manufacturer, "name"),
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


@router.get("/storage/suggest-location", response_model=LocationSuggestion)
def suggest_location_endpoint(
    material_sku_id: int,
    width_mm: float,
    parent_id: int | None = None,
    warehouse_id: int | None = None,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
) -> LocationSuggestion:
    """Автоподбор места хранения (4.2 ТЗ) — рекомендация, а не резервирование:
    вызывается заново при каждом подтверждении, гонки при параллельной
    работе не приводят к сбою (следующий вызов просто увидит слот занятым).
    warehouse_id — раздел про мультисклад, необязателен для обратной
    совместимости (без него ищет по всем складам)."""
    sku = db.get(MaterialSku, material_sku_id)
    if sku is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Позиция материала не найдена")
    location = suggest_location(db, sku=sku, width_mm=width_mm, parent_id=parent_id, warehouse_id=warehouse_id)
    return LocationSuggestion(location_code=location)
