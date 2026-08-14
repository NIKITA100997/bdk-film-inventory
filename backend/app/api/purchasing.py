from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.dictionaries import Color, Material, Thickness
from app.models.production import ProductionTaskLine, ProductionTaskLineReport
from app.models.purchasing import PurchaseRequest, Supplier
from app.models.units import MaterialSku, MaterialUnit, UnitStatus
from app.models.users import User
from app.schemas.deletion_requests import DeleteResultOut
from app.schemas.purchasing import (
    PurchaseRequestCreate,
    PurchaseRequestFulfillRequest,
    PurchaseRequestOut,
    PurchaseRequestShopFloorCreate,
    PurchaseRequestUpdate,
    StockOverviewLine,
)
from app.services.deletion_requests import request_deletion
from app.services.dictionaries import current_stock_m2, find_or_create_material_color_thickness, find_or_create_supplier
from app.services.production import TaskLineForReserve, calc_default_strip_width, reserved_area_m2_by_group

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
        order_id=req.order_id,
    )


@router.get("/stock-overview", response_model=list[StockOverviewLine])
def stock_overview(db: Session = Depends(get_db), user: User = Depends(manage_purchasing)) -> list[StockOverviewLine]:
    """«Остатки и резерв» (раздел про экран снабженца) — остаток на складе,
    резерв на текущие незавершённые задания цеха и сколько уже в открытых
    заявках, по группе материал+цвет+толщина. Отдаётся тут, а не в
    reports.py, потому что снабженцу не выдаются права на задания цеха
    (production_tasks.*) — расчёт резерва идёт под её же правом
    purchasing.manage, без обращения к производственным эндпоинтам."""
    stock_rows = (
        db.query(
            MaterialSku.material_id,
            MaterialSku.color_id,
            MaterialSku.thickness_id,
            func.sum(MaterialUnit.width_mm * MaterialUnit.length_m / 1000),
        )
        .join(MaterialUnit, MaterialUnit.material_sku_id == MaterialSku.id)
        .filter(MaterialUnit.status != UnitStatus.SPISAN)
        .group_by(MaterialSku.material_id, MaterialSku.color_id, MaterialSku.thickness_id)
        .all()
    )
    stock_by_group = {(m, c, t): round(float(area or 0), 3) for m, c, t, area in stock_rows}

    lines = db.query(ProductionTaskLine).all()
    line_ids = [line.id for line in lines]
    good_by_line: dict[int, float] = {}
    if line_ids:
        for line_id, good in (
            db.query(ProductionTaskLineReport.task_line_id, func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
            .filter(ProductionTaskLineReport.task_line_id.in_(line_ids))
            .group_by(ProductionTaskLineReport.task_line_id)
            .all()
        ):
            good_by_line[line_id] = float(good)
    reserve_input = [
        TaskLineForReserve(
            material_id=line.material_id,
            color_id=line.color_id,
            thickness_id=line.thickness_id,
            quantity_pieces=float(line.quantity_pieces),
            produced_good_pieces=good_by_line.get(line.id, 0.0),
            length_m=float(line.length_m),
            effective_strip_width_mm=(
                float(line.strip_width_mm)
                if line.strip_width_mm is not None
                else calc_default_strip_width(line.part_name, float(line.width_mm))
            ),
        )
        for line in lines
    ]
    reserved_by_group = reserved_area_m2_by_group(reserve_input)

    open_requested_rows = (
        db.query(
            PurchaseRequest.material_id,
            PurchaseRequest.color_id,
            PurchaseRequest.thickness_id,
            func.sum(PurchaseRequest.requested_area_m2),
        )
        .filter(PurchaseRequest.status == "open")
        .group_by(PurchaseRequest.material_id, PurchaseRequest.color_id, PurchaseRequest.thickness_id)
        .all()
    )
    open_requested_by_group = {(m, c, t): round(float(area or 0), 2) for m, c, t, area in open_requested_rows}

    # "Обычно берут у" — эвристика по истории заявок (последний непустой
    # поставщик для этой группы), не жёсткая связка поставщик↔номенклатура.
    supplier_history_rows = (
        db.query(PurchaseRequest.material_id, PurchaseRequest.color_id, PurchaseRequest.thickness_id, PurchaseRequest.supplier_id)
        .filter(PurchaseRequest.supplier_id.is_not(None))
        .order_by(PurchaseRequest.created_at.desc())
        .all()
    )
    usual_supplier_id_by_group: dict[tuple[int, int, int], int] = {}
    for m, c, t, supplier_id in supplier_history_rows:
        usual_supplier_id_by_group.setdefault((m, c, t), supplier_id)

    all_groups = set(stock_by_group) | set(reserved_by_group) | set(open_requested_by_group)
    result: list[StockOverviewLine] = []
    for material_id, color_id, thickness_id in all_groups:
        supplier_id = usual_supplier_id_by_group.get((material_id, color_id, thickness_id))
        result.append(
            StockOverviewLine(
                material=db.get(Material, material_id).name,
                color=db.get(Color, color_id).name,
                thickness=float(db.get(Thickness, thickness_id).value_mm),
                total_area_m2=stock_by_group.get((material_id, color_id, thickness_id), 0.0),
                reserved_area_m2=reserved_by_group.get((material_id, color_id, thickness_id), 0.0),
                open_requested_area_m2=open_requested_by_group.get((material_id, color_id, thickness_id), 0.0),
                usual_supplier=db.get(Supplier, supplier_id).name if supplier_id else None,
            )
        )
    result.sort(key=lambda r: (r.material, r.color, r.thickness))
    return result


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


def delete_purchase_request_impl(db: Session, req: PurchaseRequest) -> None:
    """Раздел про удаление сущностей — ничего не ссылается на
    purchase_requests.id кроме самого заказа поставщику (order_id), так
    что удаление всегда безопасно: если заявка была частью заказа, его
    агрегаты просто пересчитаются без неё при следующем открытии."""
    db.delete(req)


@router.delete("/{request_id}", response_model=DeleteResultOut)
def delete_purchase_request(
    request_id: int, db: Session = Depends(get_db), user: User = Depends(manage_purchasing)
) -> DeleteResultOut:
    req = db.get(PurchaseRequest, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Заявка не найдена")
    if not user.is_superuser:
        label = f"Заявка №{req.id} — {db.get(Material, req.material_id).name}, {db.get(Color, req.color_id).name}, {float(db.get(Thickness, req.thickness_id).value_mm)} мм, {float(req.requested_area_m2)} м²"
        request_deletion(db, entity_type="purchase_request", entity_id=req.id, entity_label=label, requested_by=user.id)
        db.commit()
        return DeleteResultOut(deleted=False, requested=True)
    delete_purchase_request_impl(db, req)
    db.commit()
    return DeleteResultOut(deleted=True, requested=False)
