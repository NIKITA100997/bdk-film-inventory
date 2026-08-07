from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_roles
from app.db.session import get_db
from app.models.orders import Order
from app.models.users import User
from app.schemas.orders import OrderCreate, OrderOut

router = APIRouter(prefix="/orders", tags=["orders"])


@router.get("", response_model=list[OrderOut])
def list_orders(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[Order]:
    return db.query(Order).order_by(Order.created_at.desc()).limit(200).all()


@router.post("", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
def create_order(payload: OrderCreate, db: Session = Depends(get_db), user: User = Depends(require_roles("logist"))) -> Order:
    if db.query(Order).filter(Order.number == payload.number).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Заказ с таким номером уже существует")
    order = Order(number=payload.number)
    db.add(order)
    db.commit()
    db.refresh(order)
    return order


@router.post("/{order_id}/close", response_model=OrderOut)
def close_order(
    order_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles("logist", "kladovshchik"))
) -> Order:
    """Закрытие заказа (6.6 ТЗ) — основной путь, ручная кнопка."""
    order = db.get(Order, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Заказ не найден")
    if order.status == "closed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Заказ уже закрыт")
    order.status = "closed"
    order.closed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(order)
    return order
