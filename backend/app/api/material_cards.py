from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.dictionaries import MaterialSku
from app.models.events import MaterialEvent
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.schemas.material_cards import MaterialCardOut
from app.schemas.units import MaterialUnitOut
from app.services.warehouses import rack_warehouse_names, resolve_warehouse_name

router = APIRouter(prefix="/material-cards", tags=["material-cards"])


@router.get("/{sku_id}", response_model=MaterialCardOut)
def get_material_card(sku_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> MaterialCardOut:
    """Карточка материала (2.6 ТЗ) — сгруппировано по конкретной позиции
    (SKU): материал+цвет+толщина+производитель."""
    sku = (
        db.query(MaterialSku)
        .options(
            joinedload(MaterialSku.material),
            joinedload(MaterialSku.color),
            joinedload(MaterialSku.thickness),
            joinedload(MaterialSku.manufacturer),
        )
        .filter(MaterialSku.id == sku_id)
        .first()
    )
    if sku is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Позиция материала не найдена")

    units = (
        db.query(MaterialUnit)
        .options(
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.material),
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.color),
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.thickness),
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.manufacturer),
        )
        .filter(MaterialUnit.material_sku_id == sku_id, MaterialUnit.status != UnitStatus.SPISAN)
        .order_by(MaterialUnit.width_mm.desc())
        .all()
    )
    total_area_m2 = round(sum(float(u.width_mm) * float(u.length_m) / 1000 for u in units), 3)

    # Название склада по единице (раздел про остатки по складам в карточке
    # материала) — того же приёма, что уже есть в search_units, здесь не
    # было вообще: MaterialUnitOut.warehouse_name оставался пустым.
    names = rack_warehouse_names(db)
    units_out = [
        MaterialUnitOut.model_validate(u).model_copy(update={"warehouse_name": resolve_warehouse_name(names, u.location_code)})
        for u in units
    ]

    events = (
        db.query(MaterialEvent)
        .filter(MaterialEvent.material_sku_id == sku_id)
        .order_by(MaterialEvent.timestamp.desc())
        .limit(50)
        .all()
    )

    return MaterialCardOut(
        sku=sku,
        total_area_m2=total_area_m2,
        units=units_out,
        events=events,
    )
