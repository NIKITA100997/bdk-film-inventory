from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.dictionaries import Color, Material, Thickness
from app.models.orders import Order, OrderMaterialLine
from app.models.production import ProductionTask, ProductionTaskLineReport
from app.models.units import MaterialUnit
from app.models.users import User
from app.schemas.orders import (
    OrderCreate,
    OrderDetailOut,
    OrderLineCreate,
    OrderLineOut,
    OrderOut,
    OrderReportLine,
    OrderRequirementOut,
    OrderShortageLine,
)
from app.services.dictionaries import current_stock_m2, find_or_create_material_color_thickness
from app.services.plan_fact import fetch_actual_for_orders
from app.services.production import calc_default_strip_width, compute_remaining_length_m, compute_remaining_pieces

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
    number = payload.number.strip() if payload.number and payload.number.strip() else None
    if not number:
        year = datetime.now(timezone.utc).year
        max_id = db.query(func.max(Order.id)).scalar() or 0
        candidate_num = max_id + 1
        number = f"ЗК-{year}-{candidate_num:03d}"
        while db.query(Order).filter(Order.number == number).first():
            candidate_num += 1
            number = f"ЗК-{year}-{candidate_num:03d}"
    elif db.query(Order).filter(Order.number == number).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Заказ с таким номером уже существует")

    order = Order(number=number)
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
def orders_report(
    db: Session = Depends(get_db), user: User = Depends(require_permission("reports.view"))
) -> list[OrderReportLine]:
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


@router.get("/{order_id}/requirements", response_model=list[OrderRequirementOut])
def get_order_requirements(order_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[OrderRequirementOut]:
    """Потребность по всему заказу (раздел про потребности по всему заказу)
    — реальные штрипсы/длины/остатки из строк заданий (ProductionTaskLine),
    привязанных к заказу через ProductionTask.order_id, сгруппированные по
    материалу+ширине штрипса+длине детали (не грубая оценка из м²)."""
    order = db.get(Order, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Заказ не найден")

    tasks = (
        db.query(ProductionTask)
        .options(joinedload(ProductionTask.lines))
        .filter(ProductionTask.order_id == order_id)
        .all()
    )
    lines = [line for task in tasks for line in task.lines]
    line_ids = [line.id for line in lines]
    good_by_line: dict[int, float] = {}
    if line_ids:
        rows = (
            db.query(
                ProductionTaskLineReport.task_line_id,
                func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
            )
            .filter(ProductionTaskLineReport.task_line_id.in_(line_ids))
            .group_by(ProductionTaskLineReport.task_line_id)
            .all()
        )
        good_by_line = {row[0]: float(row[1]) for row in rows}

    grouped: dict[tuple[int, int, int, float, float], dict] = {}
    for line in lines:
        remaining_pieces = compute_remaining_pieces(float(line.quantity_pieces), good_by_line.get(line.id, 0.0))
        if remaining_pieces <= 0:
            continue
        strip_width_mm = (
            float(line.strip_width_mm)
            if line.strip_width_mm is not None
            else calc_default_strip_width(line.part_name, float(line.width_mm))
        )
        key = (line.material_id, line.color_id, line.thickness_id, strip_width_mm, float(line.length_m))
        bucket = grouped.setdefault(key, {"remaining_pieces": 0.0, "remaining_length_m": 0.0, "part_names": set()})
        bucket["remaining_pieces"] += remaining_pieces
        bucket["remaining_length_m"] += compute_remaining_length_m(float(line.length_m), remaining_pieces)
        bucket["part_names"].add(line.part_name or "—")

    reqs: list[OrderRequirementOut] = []
    for (material_id, color_id, thickness_id, strip_width_mm, length_m), bucket in grouped.items():
        reqs.append(
            OrderRequirementOut(
                part_name=", ".join(sorted(bucket["part_names"])),
                material=db.get(Material, material_id).name,
                color=db.get(Color, color_id).name,
                thickness=float(db.get(Thickness, thickness_id).value_mm),
                strip_width_mm=strip_width_mm,
                length_m=length_m,
                remaining_pieces=bucket["remaining_pieces"],
                remaining_length_m=round(bucket["remaining_length_m"], 2),
            )
        )
    return reqs


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


@router.delete("/{order_id}")
def delete_order(
    order_id: int, db: Session = Depends(get_db), user: User = Depends(require_permission("orders.manage"))
):
    order = db.get(Order, order_id)
    if order is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    # Раздел про план/факт заказа — если по заказу уже была движуха (единицы
    # выданы под него или к нему привязано задание), физическое удаление
    # упадёт нарушением внешнего ключа. Явный 409 вместо голого 500 —
    # заказ с историей закрывают, а не удаляют.
    has_units = db.query(MaterialUnit.id).filter(MaterialUnit.order_id == order_id).first() is not None
    has_tasks = db.query(ProductionTask.id).filter(ProductionTask.order_id == order_id).first() is not None
    if has_units or has_tasks:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Нельзя удалить заказ — по нему уже есть движения материала или привязанные задания. Закройте заказ вместо удаления.",
        )
    db.delete(order)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{order_id}/lines/{line_id}")
def delete_order_line(
    order_id: int, line_id: int, db: Session = Depends(get_db), user: User = Depends(require_permission("orders.manage"))
):
    line = db.query(OrderMaterialLine).filter(OrderMaterialLine.id == line_id, OrderMaterialLine.order_id == order_id).first()
    if line is not None:
        db.delete(line)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
