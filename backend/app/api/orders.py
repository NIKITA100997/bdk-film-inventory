from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.dictionaries import Color, Material, Thickness
from app.models.orders import Order, OrderMaterialLine
from app.models.users import User
from app.schemas.orders import (
    OrderCreate,
    OrderDetailOut,
    OrderLineCreate,
    OrderLineOut,
    OrderOut,
    OrderReportLine,
    OrderShortageLine,
)
from app.services.dictionaries import current_stock_m2, find_or_create_material_color_thickness
from app.services.plan_fact import fetch_actual_for_orders

router = APIRouter(prefix="/orders", tags=["orders"])

# Строки потребности заказа — та же роль, что раньше вела недельный план
# (2.7 ТЗ), теперь просто на уровне заказа, а не календарной недели.
manage_order_lines = require_permission("orders.plan")


def _line_out(db: Session, line: OrderMaterialLine) -> OrderLineOut:
    stock = current_stock_m2(db, material_id=line.material_id, color_id=line.color_id, thickness_id=line.thickness_id)
    actual = fetch_actual_for_orders(
        db,
        order_ids=[line.order_id],
        material_id=line.material_id,
        color_id=line.color_id,
        thickness_id=line.thickness_id,
    )
    planned = float(line.planned_area_m2)
    return OrderLineOut(
        id=line.id,
        material=db.get(Material, line.material_id).name,
        color=db.get(Color, line.color_id).name,
        thickness=float(db.get(Thickness, line.thickness_id).value_mm),
        planned_area_m2=planned,
        current_stock_m2=stock,
        shortage=stock < planned,
        actual_area_m2=actual.total_area_m2,
        percent_complete=round(actual.total_area_m2 / planned * 100, 1) if planned else 0,
        by_width=actual.by_width,
    )


@router.get("", response_model=list[OrderOut])
def list_orders(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[Order]:
    return db.query(Order).order_by(Order.created_at.desc()).limit(200).all()


@router.post("", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
def create_order(
    payload: OrderCreate, db: Session = Depends(get_db), user: User = Depends(require_permission("orders.manage"))
) -> Order:
    if db.query(Order).filter(Order.number == payload.number).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Заказ с таким номером уже существует")
    order = Order(number=payload.number)
    db.add(order)
    db.commit()
    db.refresh(order)
    return order


@router.get("/shortages", response_model=list[OrderShortageLine])
def list_shortages(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[OrderShortageLine]:
    """Сигналы нехватки (раздел «Закупки») по всем открытым заказам сразу
    — раньше источником была одна "последняя" неделя недельного плана."""
    open_orders = db.query(Order).filter(Order.status == "open").all()
    result: list[OrderShortageLine] = []
    for order in open_orders:
        for line in order.lines:
            stock = current_stock_m2(db, material_id=line.material_id, color_id=line.color_id, thickness_id=line.thickness_id)
            planned = float(line.planned_area_m2)
            if stock < planned:
                result.append(
                    OrderShortageLine(
                        order_id=order.id,
                        order_number=order.number,
                        line_id=line.id,
                        material=db.get(Material, line.material_id).name,
                        color=db.get(Color, line.color_id).name,
                        thickness=float(db.get(Thickness, line.thickness_id).value_mm),
                        planned_area_m2=planned,
                        current_stock_m2=stock,
                    )
                )
    return result


@router.get("/report", response_model=list[OrderReportLine])
def orders_report(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[OrderReportLine]:
    """Сводный отчёт по всем заказам (4 раздел обратной связи) — отдельно
    от карточки конкретного заказа, для «Отчётов»."""
    orders = db.query(Order).order_by(Order.created_at.desc()).limit(200).all()
    result: list[OrderReportLine] = []
    for order in orders:
        planned = 0.0
        actual = 0.0
        shortage_lines = 0
        for line in order.lines:
            planned += float(line.planned_area_m2)
            actual += fetch_actual_for_orders(
                db,
                order_ids=[order.id],
                material_id=line.material_id,
                color_id=line.color_id,
                thickness_id=line.thickness_id,
            ).total_area_m2
            stock = current_stock_m2(db, material_id=line.material_id, color_id=line.color_id, thickness_id=line.thickness_id)
            if stock < float(line.planned_area_m2):
                shortage_lines += 1
        result.append(
            OrderReportLine(
                id=order.id,
                number=order.number,
                status=order.status,
                created_at=order.created_at,
                closed_at=order.closed_at,
                planned_area_m2=round(planned, 3),
                actual_area_m2=round(actual, 3),
                percent_complete=round(actual / planned * 100, 1) if planned else 0,
                shortage_line_count=shortage_lines,
            )
        )
    return result


@router.get("/{order_id}", response_model=OrderDetailOut)
def get_order(order_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> OrderDetailOut:
    order = db.get(Order, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Заказ не найден")
    return OrderDetailOut(
        id=order.id,
        number=order.number,
        status=order.status,
        created_at=order.created_at,
        closed_at=order.closed_at,
        lines=[_line_out(db, line) for line in order.lines],
    )


@router.post("/{order_id}/lines", response_model=OrderLineOut, status_code=status.HTTP_201_CREATED)
def add_order_line(
    order_id: int,
    payload: OrderLineCreate,
    db: Session = Depends(get_db),
    user: User = Depends(manage_order_lines),
) -> OrderLineOut:
    order = db.get(Order, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Заказ не найден")
    material, color, thickness = find_or_create_material_color_thickness(
        db, material=payload.material, color=payload.color, thickness=payload.thickness
    )
    line = OrderMaterialLine(
        order_id=order_id,
        material_id=material.id,
        color_id=color.id,
        thickness_id=thickness.id,
        planned_area_m2=payload.planned_area_m2,
    )
    db.add(line)
    db.commit()
    db.refresh(line)
    return _line_out(db, line)


@router.post("/{order_id}/close", response_model=OrderOut)
def close_order(
    order_id: int, db: Session = Depends(get_db), user: User = Depends(require_permission("orders.close"))
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
