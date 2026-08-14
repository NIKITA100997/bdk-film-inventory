from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.dictionaries import MaterialSku
from app.models.events import MaterialEvent
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.schemas.material_cards import MaterialCardOut

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
        units=units,
        events=events,
    )
