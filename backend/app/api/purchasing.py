from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.dictionaries import Color, Material, Thickness
from app.models.purchasing import PurchaseRequest, Supplier
from app.models.users import User
from app.schemas.purchasing import (
    PurchaseRequestCreate,
    PurchaseRequestFulfillRequest,
    PurchaseRequestOut,
    PurchaseRequestShopFloorCreate,
    PurchaseRequestUpdate,
)
from app.services.dictionaries import current_stock_m2, find_or_create_material_color_thickness, find_or_create_supplier

router = APIRouter(prefix="/purchase-requests", tags=["purchasing"])

manage_purchasing = require_permission("purchasing.manage")
# С "Выдачи участку" (units.issue) — сигнал нехватки прямо в моменте
# выдачи; с "Приёмки" (units.receive) — привязка заявки к конкретной
# поставке по УПД. Ни то ни другое не требует прав снабженца.
create_shop_floor_request = require_permission("units.issue")
fulfill_purchase_request_perm = require_permission("units.receive")


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
        origin=req.origin,
        linked_upd_number=req.linked_upd_number,
        created_by=req.created_by,
        created_at=req.created_at,
        closed_at=req.closed_at,
        supplier=db.get(Supplier, req.supplier_id).name if req.supplier_id else None,
        price_per_m2=float(req.price_per_m2) if req.price_per_m2 is not None else None,
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
    supplier = find_or_create_supplier(db, payload.supplier) if payload.supplier else None
    req = PurchaseRequest(
        material_id=material.id,
        color_id=color.id,
        thickness_id=thickness.id,
        requested_area_m2=payload.requested_area_m2,
        note=payload.note,
        origin="planner",
        created_by=user.id,
        supplier_id=supplier.id if supplier else None,
        price_per_m2=payload.price_per_m2,
    )
    db.add(req)
    db.commit()
    db.refresh(req)
    return _out(db, req)


@router.post("/shop-floor", response_model=PurchaseRequestOut, status_code=status.HTTP_201_CREATED)
def create_shop_floor_purchase_request(
    payload: PurchaseRequestShopFloorCreate,
    db: Session = Depends(get_db),
    user: User = Depends(create_shop_floor_request),
) -> PurchaseRequestOut:
    """Заявка "с цеха" — кнопка "Подать заявку на закупку" на "Выдаче
    участку", когда остатка на складе не хватает под строку задания. Без
    supplier/price_per_m2 — их выбирает снабженец позже на "Закупках"."""
    material, color, thickness = find_or_create_material_color_thickness(
        db, material=payload.material, color=payload.color, thickness=payload.thickness
    )
    req = PurchaseRequest(
        material_id=material.id,
        color_id=color.id,
        thickness_id=thickness.id,
        requested_area_m2=payload.requested_area_m2,
        note=payload.note,
        origin="shop_floor",
        created_by=user.id,
    )
    db.add(req)
    db.commit()
    db.refresh(req)
    return _out(db, req)


@router.post("/{request_id}/fulfill", response_model=PurchaseRequestOut)
def fulfill_purchase_request(
    request_id: int,
    payload: PurchaseRequestFulfillRequest,
    db: Session = Depends(get_db),
    user: User = Depends(fulfill_purchase_request_perm),
) -> PurchaseRequestOut:
    """Привязка заявки к конкретной приёмке по УПД (раздел про ускорение
    приёмки) — получатель на "Приёмке" выбрал открытую заявку, которую эта
    поставка закрывает. Отдельно от группового auto_close_on_receipt
    (services/purchasing.py) — тот остаётся как более грубый резерв для
    заявок, которые никто явно не привязал."""
    req = db.get(PurchaseRequest, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Заявка не найдена")
    if req.status == "closed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Заявка уже закрыта")
    req.status = "closed"
    req.closed_at = datetime.now(timezone.utc)
    req.linked_upd_number = payload.upd_number
    db.commit()
    db.refresh(req)
    return _out(db, req)


@router.patch("/{request_id}", response_model=PurchaseRequestOut)
def update_purchase_request(
    request_id: int,
    payload: PurchaseRequestUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(manage_purchasing),
) -> PurchaseRequestOut:
    """Цена/поставщик согласованы позже создания заявки (раздел про историю
    цен и сроков поставщика) — материал/цвет/толщина/объём неизменны."""
    req = db.get(PurchaseRequest, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Заявка не найдена")
    if payload.supplier is not None:
        req.supplier_id = find_or_create_supplier(db, payload.supplier).id
    if payload.price_per_m2 is not None:
        req.price_per_m2 = payload.price_per_m2
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
