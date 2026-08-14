"""Рассмотрение заявок на удаление (раздел про удаление сущностей) —
суперпользователь одобряет (реально удаляет через ту же guarded-функцию,
что и его собственное прямое удаление) или отклоняет (заявка помечается
rejected, сущность не трогается)."""

from datetime import datetime, timezone
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dictionaries import delete_material_sku_impl
from app.api.production import delete_production_task_impl
from app.api.purchasing import delete_purchase_request_impl
from app.api.supplier_orders import delete_supplier_order_impl
from app.api.units import delete_unit_impl
from app.core.security import require_permission
from app.db.session import get_db
from app.models.deletion_requests import DeletionRequest
from app.models.dictionaries import MaterialSku
from app.models.production import ProductionTask
from app.models.purchasing import PurchaseRequest, SupplierOrder
from app.models.units import MaterialUnit
from app.models.users import User
from app.schemas.deletion_requests import DeletionRequestOut, DeletionRequestReject

router = APIRouter(tags=["deletion-requests"])

manage_deletion_requests = require_permission("users.manage")

# entity_type -> (модель, guarded-delete функция) — общая для прямого
# DELETE суперпользователя (api/*.py) и одобрения заявки здесь.
_DISPATCH: dict[str, tuple[type, Callable[[Session, object], None]]] = {
    "production_task": (ProductionTask, delete_production_task_impl),
    "supplier_order": (SupplierOrder, delete_supplier_order_impl),
    "purchase_request": (PurchaseRequest, delete_purchase_request_impl),
    "material_sku": (MaterialSku, delete_material_sku_impl),
    "material_unit": (MaterialUnit, delete_unit_impl),
}


def _out(db: Session, req: DeletionRequest) -> DeletionRequestOut:
    requester = db.get(User, req.requested_by)
    return DeletionRequestOut(
        id=req.id,
        entity_type=req.entity_type,
        entity_id=req.entity_id,
        entity_label=req.entity_label,
        reason=req.reason,
        status=req.status,
        requested_by=req.requested_by,
        requested_by_name=requester.full_name if requester else "—",
        created_at=req.created_at,
        resolved_by=req.resolved_by,
        resolved_at=req.resolved_at,
        resolution_note=req.resolution_note,
    )


@router.get("/deletion-requests", response_model=list[DeletionRequestOut])
def list_deletion_requests(
    status_filter: str | None = None, db: Session = Depends(get_db), user: User = Depends(manage_deletion_requests)
) -> list[DeletionRequestOut]:
    query = db.query(DeletionRequest)
    if status_filter is not None:
        query = query.filter(DeletionRequest.status == status_filter)
    requests = query.order_by(DeletionRequest.created_at.desc()).limit(200).all()
    return [_out(db, r) for r in requests]


@router.post("/deletion-requests/{request_id}/approve", response_model=DeletionRequestOut)
def approve_deletion_request(
    request_id: int, db: Session = Depends(get_db), user: User = Depends(manage_deletion_requests)
) -> DeletionRequestOut:
    if not user.is_superuser:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Только суперпользователь может одобрять удаление")
    req = db.get(DeletionRequest, request_id)
    if req is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заявка не найдена")
    if req.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "Заявка уже рассмотрена")
    model, delete_fn = _DISPATCH[req.entity_type]
    entity = db.get(model, req.entity_id)
    if entity is None:
        req.status = "rejected"
        req.resolution_note = "Сущность уже удалена или отсутствует"
    else:
        delete_fn(db, entity)  # может бросить 409, если теперь нельзя (появилась история) — заявка останется pending
        req.status = "approved"
    req.resolved_by = user.id
    req.resolved_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(req)
    return _out(db, req)


@router.post("/deletion-requests/{request_id}/reject", response_model=DeletionRequestOut)
def reject_deletion_request(
    request_id: int, payload: DeletionRequestReject, db: Session = Depends(get_db), user: User = Depends(manage_deletion_requests)
) -> DeletionRequestOut:
    req = db.get(DeletionRequest, request_id)
    if req is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заявка не найдена")
    if req.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "Заявка уже рассмотрена")
    req.status = "rejected"
    req.resolution_note = payload.note
    req.resolved_by = user.id
    req.resolved_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(req)
    return _out(db, req)
