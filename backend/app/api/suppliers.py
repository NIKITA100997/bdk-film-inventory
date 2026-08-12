from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.purchasing import PurchaseRequest, Supplier
from app.models.users import User
from app.schemas.suppliers import SupplierCreate, SupplierOut, SupplierStatsOut, SupplierUpdate
from app.services.suppliers import ClosedRequestRecord, compute_supplier_stats

router = APIRouter(prefix="/suppliers", tags=["suppliers"])

manage_suppliers = require_permission("purchasing.manage")


@router.get("", response_model=list[SupplierOut])
def list_suppliers(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[Supplier]:
    return db.query(Supplier).filter(Supplier.is_active).order_by(Supplier.name).all()


@router.post("", response_model=SupplierOut, status_code=status.HTTP_201_CREATED)
def create_supplier(
    payload: SupplierCreate, db: Session = Depends(get_db), user: User = Depends(manage_suppliers)
) -> Supplier:
    existing = db.query(Supplier).filter_by(name=payload.name).first()
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Поставщик с таким именем уже есть")
    supplier = Supplier(name=payload.name, contact=payload.contact)
    db.add(supplier)
    db.commit()
    db.refresh(supplier)
    return supplier


@router.patch("/{supplier_id}", response_model=SupplierOut)
def update_supplier(
    supplier_id: int, payload: SupplierUpdate, db: Session = Depends(get_db), user: User = Depends(manage_suppliers)
) -> Supplier:
    supplier = db.get(Supplier, supplier_id)
    if supplier is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Поставщик не найден")
    if payload.name is not None:
        supplier.name = payload.name
    if payload.contact is not None:
        supplier.contact = payload.contact
    if payload.is_active is not None:
        supplier.is_active = payload.is_active
    db.commit()
    db.refresh(supplier)
    return supplier


@router.get("/stats/history", response_model=list[SupplierStatsOut])
def supplier_stats(db: Session = Depends(get_db), user: User = Depends(manage_suppliers)) -> list[SupplierStatsOut]:
    """История цен и сроков поставщика (раздел про расширение функционала)
    — агрегат по закрытым заявкам с проставленным поставщиком."""
    rows = (
        db.query(PurchaseRequest, Supplier.name)
        .join(Supplier, PurchaseRequest.supplier_id == Supplier.id)
        .filter(PurchaseRequest.status == "closed", PurchaseRequest.supplier_id.isnot(None))
        .all()
    )
    records = [
        ClosedRequestRecord(
            supplier_id=req.supplier_id,
            supplier_name=supplier_name,
            price_per_m2=float(req.price_per_m2) if req.price_per_m2 is not None else None,
            created_at=req.created_at,
            closed_at=req.closed_at,
        )
        for req, supplier_name in rows
    ]
    return compute_supplier_stats(records)
