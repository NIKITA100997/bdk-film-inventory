from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_roles
from app.db.session import get_db
from app.models.events import EventType
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.schemas.units import MaterialUnitOut, ReceiveRequest
from app.services.events import record_event

router = APIRouter(prefix="/units", tags=["units"])


@router.post("/receive", response_model=list[MaterialUnitOut], status_code=status.HTTP_201_CREATED)
def receive(
    payload: ReceiveRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("operator_sklada")),
) -> list[MaterialUnit]:
    """Приёмка партии (6.2 ТЗ): создаёт N единиц-рулонов под одним УПД/паллетой."""
    created: list[MaterialUnit] = []
    for _ in range(payload.quantity):
        unit = MaterialUnit(
            upd_number=payload.upd_number,
            pallet_number=payload.pallet_number,
            material=payload.material,
            color=payload.color,
            thickness=payload.thickness,
            manufacturer=payload.manufacturer,
            width_mm=payload.width_mm,
            length_m=payload.length_m,
            status=UnitStatus.PRINYAT,
            location_code=payload.location_code,
        )
        db.add(unit)
        db.flush()  # получить unit.id для события
        record_event(
            db,
            unit=unit,
            event_type=EventType.PRIHOD,
            user_id=user.id,
            quantity_delta_m=payload.length_m,
            to_length=payload.length_m,
            to_cell=payload.location_code,
        )
        created.append(unit)
    db.commit()
    for unit in created:
        db.refresh(unit)
    return created


@router.get("/{unit_id}", response_model=MaterialUnitOut)
def get_unit(
    unit_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MaterialUnit:
    unit = db.get(MaterialUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")
    return unit
