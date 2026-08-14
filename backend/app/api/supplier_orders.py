"""Заказы поставщикам (раздел про экран снабженца) — объединение
нескольких заявок (в т.ч. с цеха, под разные задания) в один заказ
одному поставщику. Заявки остаются отдельными записями (см.
models/purchasing.py::SupplierOrder), группировка по номенклатуре внутри
заказа — на уровне ответа этого эндпоинта, не в БД."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.dictionaries import Color, Material, Thickness
from app.models.purchasing import PurchaseRequest, Supplier, SupplierOrder
from app.models.users import User
from app.schemas.deletion_requests import DeleteResultOut
from app.schemas.purchasing import SupplierOrderCreate, SupplierOrderLineOut, SupplierOrderOut
from app.services.deletion_requests import request_deletion
from app.services.dictionaries import current_stock_m2, find_or_create_supplier

router = APIRouter(tags=["purchasing"])

manage_purchasing = require_permission("purchasing.manage")


def _order_out(db: Session, order: SupplierOrder) -> SupplierOrderOut:
    requests = db.query(PurchaseRequest).filter(PurchaseRequest.order_id == order.id).all()
    lines: dict[tuple[int, int, int], SupplierOrderLineOut] = {}
    for req in requests:
        key = (req.material_id, req.color_id, req.thickness_id)
        if key in lines:
            existing = lines[key]
            existing.requested_area_m2 = round(existing.requested_area_m2 + float(req.requested_area_m2), 2)
            existing.request_ids.append(req.id)
        else:
            lines[key] = SupplierOrderLineOut(
                material=db.get(Material, req.material_id).name,
                color=db.get(Color, req.color_id).name,
                thickness=float(db.get(Thickness, req.thickness_id).value_mm),
                requested_area_m2=float(req.requested_area_m2),
                current_stock_m2=current_stock_m2(
                    db, material_id=req.material_id, color_id=req.color_id, thickness_id=req.thickness_id
                ),
                request_ids=[req.id],
            )
    return SupplierOrderOut(
        id=order.id,
        supplier=db.get(Supplier, order.supplier_id).name,
        note=order.note,
        created_by=order.created_by,
        created_at=order.created_at,
        is_open=any(r.status == "open" for r in requests),
        lines=list(lines.values()),
    )


@router.get("/supplier-orders", response_model=list[SupplierOrderOut])
def list_supplier_orders(db: Session = Depends(get_db), user: User = Depends(manage_purchasing)) -> list[SupplierOrderOut]:
    orders = db.query(SupplierOrder).order_by(SupplierOrder.created_at.desc()).limit(200).all()
    return [_order_out(db, o) for o in orders]


@router.post("/supplier-orders", response_model=SupplierOrderOut, status_code=status.HTTP_201_CREATED)
def create_supplier_order(
    payload: SupplierOrderCreate, db: Session = Depends(get_db), user: User = Depends(manage_purchasing)
) -> SupplierOrderOut:
    requests = db.query(PurchaseRequest).filter(PurchaseRequest.id.in_(payload.request_ids)).all()
    if len(requests) != len(set(payload.request_ids)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Часть заявок не найдена")
    not_eligible = [r.id for r in requests if r.status != "open" or r.order_id is not None]
    if not_eligible:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Заявки {not_eligible} уже закрыты или в другом заказе — обновите список и попробуйте снова",
        )

    supplier = find_or_create_supplier(db, payload.supplier)
    order = SupplierOrder(supplier_id=supplier.id, note=payload.note, created_by=user.id)
    db.add(order)
    db.flush()
    for req in requests:
        req.order_id = order.id
        req.supplier_id = supplier.id
    db.commit()
    db.refresh(order)
    return _order_out(db, order)


def delete_supplier_order_impl(db: Session, order: SupplierOrder) -> None:
    """Раздел про удаление сущностей — заказ лишь группирует заявки
    (см. models/purchasing.py::SupplierOrder), поэтому удаление заказа не
    трогает сами заявки, только отвязывает их (order_id = NULL) — они
    остаются в "Заявках поставщику" как будто их ещё не объединяли."""
    db.query(PurchaseRequest).filter(PurchaseRequest.order_id == order.id).update({"order_id": None})
    db.delete(order)


@router.delete("/supplier-orders/{order_id}", response_model=DeleteResultOut)
def delete_supplier_order(
    order_id: int, db: Session = Depends(get_db), user: User = Depends(manage_purchasing)
) -> DeleteResultOut:
    order = db.get(SupplierOrder, order_id)
    if order is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заказ не найден")
    if not user.is_superuser:
        supplier = db.get(Supplier, order.supplier_id)
        request_deletion(
            db, entity_type="supplier_order", entity_id=order.id, entity_label=f"Заказ №{order.id} — {supplier.name}", requested_by=user.id
        )
        db.commit()
        return DeleteResultOut(deleted=False, requested=True)
    delete_supplier_order_impl(db, order)
    db.commit()
    return DeleteResultOut(deleted=True, requested=False)
