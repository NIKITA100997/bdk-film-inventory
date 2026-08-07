from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import require_roles
from app.db.session import get_db
from app.models.dictionaries import Color, Material, Thickness
from app.models.purchasing import PurchaseRequest
from app.models.users import User
from app.schemas.purchasing import PurchaseRequestCreate, PurchaseRequestOut
from app.services.dictionaries import current_stock_m2, find_or_create_material_color_thickness

router = APIRouter(prefix="/purchase-requests", tags=["purchasing"])

manage_purchasing = require_roles("snabzhenets")


def _out(db: Session, req: PurchaseRequest) -> PurchaseRequestOut:
    stock = current_stock_m2(db, material_id=req.material_id, color_id=req.color_id, thickness_id=req.thickness_id)
    return PurchaseRequestOut(
        id=req.id,
        material=db.get(Material, req.material_id).name,
        color=db.get(Color, req.color_id).name,
        thickness=float(db.get(Thickness, req.thickness_id).value_mm),
        requested_area_m2=float(req.requested_area_m2),
        current_stock_m2=stock,
        note=req.note,
        status=req.status,
        created_by=req.created_by,
        created_at=req.created_at,
        closed_at=req.closed_at,
    )


@router.get("", response_model=list[PurchaseRequestOut])
def list_purchase_requests(
    status_filter: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(manage_purchasing),
) -> list[PurchaseRequestOut]:
    """История закупок (5.5 ТЗ) — открытые и закрытые заявки снабженцу."""
    query = db.query(PurchaseRequest)
    if status_filter is not None:
        query = query.filter(PurchaseRequest.status == status_filter)
    requests = query.order_by(PurchaseRequest.created_at.desc()).limit(200).all()
    return [_out(db, r) for r in requests]


@router.post("", response_model=PurchaseRequestOut, status_code=status.HTTP_201_CREATED)
def create_purchase_request(
    payload: PurchaseRequestCreate,
    db: Session = Depends(get_db),
    user: User = Depends(manage_purchasing),
) -> PurchaseRequestOut:
    """Заявка поставщику по сигналу нехватки (6.1 ТЗ) — материал/цвет/
    толщина вводятся текстом, как везде, и резолвятся в справочники."""
    material, color, thickness = find_or_create_material_color_thickness(
        db, material=payload.material, color=payload.color, thickness=payload.thickness
    )
    req = PurchaseRequest(
        material_id=material.id,
        color_id=color.id,
        thickness_id=thickness.id,
        requested_area_m2=payload.requested_area_m2,
        note=payload.note,
        created_by=user.id,
    )
    db.add(req)
    db.commit()
    db.refresh(req)
    return _out(db, req)


@router.post("/{request_id}/close", response_model=PurchaseRequestOut)
def close_purchase_request(
    request_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(manage_purchasing),
) -> PurchaseRequestOut:
    """Ручное закрытие — например, заказ отменён. Обычно заявка закрывается
    автоматически ближайшей приёмкой той же группы материала."""
    req = db.get(PurchaseRequest, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Заявка не найдена")
    if req.status == "closed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Заявка уже закрыта")
    req.status = "closed"
    req.closed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(req)
    return _out(db, req)
