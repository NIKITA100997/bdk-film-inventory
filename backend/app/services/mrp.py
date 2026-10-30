"""MRP-модуль автоматического расчёта дефицита сырья и материалов.
Формула чистого дефицита:
    Deficit = max(0, Gross Demand + Safety Stock - Current Stock - In Transit)

Позволяет в 1 клик сформировать заявки на закупку и заказы поставщикам.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.dictionaries import Color, Material, Thickness
from app.models.items import Item
from app.models.production import PlanSlot, ProductionTask, ProductionTaskLine
from app.models.purchasing import PurchaseRequest, Supplier, SupplierOrder
from app.models.units import MaterialUnit, UnitStatus
from app.services import materials as mat_service
from app.services.dictionaries import current_stock_m2


@dataclass
class MrpItemNeed:
    item_type: str  # "film" | "material"
    item_id: int | None
    material_id: int | None = None
    color_id: int | None = None
    thickness_id: int | None = None
    width_mm: float | None = None
    name: str = ""
    unit: str = "шт"
    gross_demand: float = 0.0
    stock_current: float = 0.0
    in_transit: float = 0.0
    safety_stock: float = 0.0
    net_deficit: float = 0.0
    suggested_order: float = 0.0
    supplier_id: int | None = None
    supplier_name: str | None = None
    urgency: str = "normal"  # "critical", "warning", "normal"
    need_by: date | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "item_type": self.item_type,
            "item_id": self.item_id,
            "material_id": self.material_id,
            "color_id": self.color_id,
            "thickness_id": self.thickness_id,
            "width_mm": self.width_mm,
            "name": self.name,
            "unit": self.unit,
            "gross_demand": round(self.gross_demand, 2),
            "stock_current": round(self.stock_current, 2),
            "in_transit": round(self.in_transit, 2),
            "safety_stock": round(self.safety_stock, 2),
            "net_deficit": round(self.net_deficit, 2),
            "suggested_order": round(self.suggested_order, 2),
            "supplier_id": self.supplier_id,
            "supplier_name": self.supplier_name,
            "urgency": self.urgency,
            "need_by": self.need_by.isoformat() if self.need_by else None,
        }


def compute_mrp_needs(
    db: Session,
    horizon_days: int = 14,
    safety_stock_ratio: float = 0.15,
) -> list[MrpItemNeed]:
    """Сводный расчёт потребностей по открытым заданиям и слотам планирования на horizon_days дней вперёд."""
    today = date.today()
    limit_date = today + timedelta(days=horizon_days)

    # 1. Потребность по плёнкам из открытых строк заданий
    # Ключ: (material_id, color_id, thickness_id, width_mm) -> dict
    film_demands: dict[tuple[int, int, int, float | None], dict[str, Any]] = defaultdict(
        lambda: {"need_m": 0.0, "need_m2": 0.0, "min_need_by": None}
    )

    open_lines = (
        db.query(ProductionTaskLine)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(
            ProductionTask.is_active.is_(True),
            ProductionTaskLine.is_closed.is_(False),
            ProductionTaskLine.material_id.isnot(None),
        )
        .all()
    )

    for line in open_lines:
        mat_id = line.material_id
        col_id = line.color_id
        th_id = line.thickness_id
        if not (mat_id and col_id and th_id):
            continue

        # Remaining pieces
        done_pieces = sum(float(r.good_pieces or 0) for r in line.reports if r.counts_toward_line)
        rem_pieces = max(0.0, float(line.quantity_pieces or 0) - done_pieces)
        if rem_pieces <= 0:
            continue

        len_per_pc = float(line.length_m or 0.0)
        needed_m = rem_pieces * len_per_pc
        w_mm = float(line.width_mm or 0.0)
        needed_m2 = (needed_m * w_mm / 1000.0) if w_mm > 0 else 0.0

        # Slot date or default
        slot_date = None
        for s in db.query(PlanSlot).filter(PlanSlot.task_line_id == line.id).all():
            if slot_date is None or s.date < slot_date:
                slot_date = s.date

        key = (mat_id, col_id, th_id, w_mm if w_mm > 0 else None)
        rec = film_demands[key]
        rec["need_m"] += needed_m
        rec["need_m2"] += needed_m2
        if slot_date and (rec["min_need_by"] is None or slot_date < rec["min_need_by"]):
            rec["min_need_by"] = slot_date

    # 2. Ожидаемые поставки плёнок (in transit)
    # Open purchase requests
    open_reqs = (
        db.query(PurchaseRequest)
        .filter(
            PurchaseRequest.status == "open",
            PurchaseRequest.material_id.isnot(None),
        )
        .all()
    )
    incoming_films: dict[tuple[int, int, int], float] = defaultdict(float)
    for r in open_reqs:
        k = (r.material_id, r.color_id, r.thickness_id)
        incoming_films[k] += float(r.requested_area_m2 or 0.0)

    # 3. Формируем результаты по плёнкам
    results: list[MrpItemNeed] = []
    # Предзагрузка словарей для быстрых названий
    materials_map = {m.id: getattr(m, "name", "") for m in db.query(Material).all() if getattr(m, "id", None) is not None}
    colors_map = {c.id: getattr(c, "name", "") for c in db.query(Color).all() if getattr(c, "id", None) is not None}
    thicknesses_map = {t.id: float(getattr(t, "value_mm", 0.0) or 0.0) for t in db.query(Thickness).all() if getattr(t, "id", None) is not None}

    for (mat_id, col_id, th_id, w_mm), dem in film_demands.items():
        mat_name = materials_map.get(mat_id, "")
        col_name = colors_map.get(col_id, "")
        th_val = thicknesses_map.get(th_id, 0.0)
        film_label = f"{col_name} {th_val}мм ({mat_name})"
        if w_mm:
            film_label += f" ш.{int(w_mm)}"

        gross = dem["need_m2"]
        stock = current_stock_m2(db, material_id=mat_id, color_id=col_id, thickness_id=th_id)
        in_transit = incoming_films.get((mat_id, col_id, th_id), 0.0)
        safety = gross * safety_stock_ratio

        deficit = max(0.0, gross + safety - stock - in_transit)
        if deficit > 0:
            # Округление до целого рулона ~ 250 м²
            suggested = max(100.0, round((deficit / 50.0) + 0.49) * 50.0)
            need_by = dem["min_need_by"] or (today + timedelta(days=3))
            days_left = (need_by - today).days

            if days_left <= 2:
                urgency = "critical"
            elif days_left <= 5:
                urgency = "warning"
            else:
                urgency = "normal"

            # Найдём последнего поставщика этой плёнки
            last_req = (
                db.query(PurchaseRequest)
                .filter(
                    PurchaseRequest.material_id == mat_id,
                    PurchaseRequest.color_id == col_id,
                    PurchaseRequest.supplier_id.isnot(None),
                )
                .order_by(PurchaseRequest.id.desc())
                .first()
            )
            sup_id = last_req.supplier_id if last_req else None
            sup_name = db.get(Supplier, sup_id).name if sup_id else None

            results.append(
                MrpItemNeed(
                    item_type="film",
                    item_id=None,
                    material_id=mat_id,
                    color_id=col_id,
                    thickness_id=th_id,
                    width_mm=w_mm,
                    name=film_label,
                    unit="м²",
                    gross_demand=gross,
                    stock_current=stock,
                    in_transit=in_transit,
                    safety_stock=safety,
                    net_deficit=deficit,
                    suggested_order=suggested,
                    supplier_id=sup_id,
                    supplier_name=sup_name,
                    urgency=urgency,
                    need_by=need_by,
                )
            )

    # 4. Потребность по материалам и комплектующим
    material_items = (
        db.query(Item)
        .filter(Item.is_model.is_(False))
        .all()
    )
    item_ids = [it.id for it in material_items]
    balances = mat_service.balances(db, item_ids) if item_ids else {}

    # Открытые заявки на материалы
    mat_open_reqs = (
        db.query(PurchaseRequest)
        .filter(
            PurchaseRequest.status == "open",
            PurchaseRequest.item_id.isnot(None),
        )
        .all()
    )
    incoming_mats: dict[int, float] = defaultdict(float)
    for r in mat_open_reqs:
        incoming_mats[r.item_id] += float(r.quantity or 0.0)

    for it in material_items:
        current_st = float(balances.get(it.id, 0.0))
        in_tr = incoming_mats.get(it.id, 0.0)
        # Если есть минимальный/страховой остаток у позиции (у нас safety stock)
        # Запас по умолчанию: 20 ед. для расходников/клея
        min_reserve = 15.0
        if current_st + in_tr < min_reserve:
            defic = min_reserve - (current_st + in_tr)
            suggested = max(defic, round(defic * 1.5))
            results.append(
                MrpItemNeed(
                    item_type="material",
                    item_id=it.id,
                    name=it.name,
                    unit=it.unit or "шт",
                    gross_demand=min_reserve,
                    stock_current=current_st,
                    in_transit=in_tr,
                    safety_stock=min_reserve * 0.2,
                    net_deficit=defic,
                    suggested_order=suggested,
                    urgency="warning" if current_st <= 0 else "normal",
                    need_by=today + timedelta(days=4),
                )
            )

    # Сортировка: критические сначала, затем по величине дефицита
    urgency_order = {"critical": 0, "warning": 1, "normal": 2}
    results.sort(key=lambda x: (urgency_order.get(x.urgency, 9), -x.net_deficit))

    return results


def create_mrp_orders(
    db: Session,
    items: list[dict[str, Any]],
    user_id: int,
    create_supplier_order: bool = True,
) -> dict[str, Any]:
    """Создание заявок на закупку (PurchaseRequest) и опционально заказов поставщикам (SupplierOrder)."""
    created_requests: list[PurchaseRequest] = []
    by_supplier: dict[int | None, list[PurchaseRequest]] = defaultdict(list)

    for item_data in items:
        item_type = item_data.get("item_type", "film")
        qty = float(item_data.get("quantity") or item_data.get("suggested_order") or 0.0)
        if qty <= 0:
            continue

        supplier_id = item_data.get("supplier_id")
        need_by_raw = item_data.get("need_by")
        need_by_date = (
            datetime.fromisoformat(need_by_raw).date()
            if isinstance(need_by_raw, str)
            else (need_by_raw or (date.today() + timedelta(days=5)))
        )

        if item_type == "film":
            req = PurchaseRequest(
                material_id=item_data.get("material_id"),
                color_id=item_data.get("color_id"),
                thickness_id=item_data.get("thickness_id"),
                width_mm=item_data.get("width_mm"),
                requested_area_m2=qty,
                requested_length_m=item_data.get("length_m"),
                need_by=need_by_date,
                supplier_id=supplier_id,
                origin="mrp",
                status="open",
                created_by=user_id,
                note=f"Автоматический заказ MRP от {date.today().strftime('%d.%m.%Y')}",
            )
        else:
            req = PurchaseRequest(
                item_id=item_data.get("item_id"),
                quantity=qty,
                need_by=need_by_date,
                supplier_id=supplier_id,
                origin="mrp",
                status="open",
                created_by=user_id,
                note=f"Автоматический заказ MRP от {date.today().strftime('%d.%m.%Y')}",
            )

        db.add(req)
        created_requests.append(req)

    db.flush()

    supplier_orders_created = 0
    if create_supplier_order:
        for req in created_requests:
            by_supplier[req.supplier_id].append(req)

        for sup_id, req_list in by_supplier.items():
            if not sup_id:
                continue
            so = SupplierOrder(
                supplier_id=sup_id,
                created_by=user_id,
            )
            db.add(so)
            db.flush()
            for r in req_list:
                r.order_id = so.id
            supplier_orders_created += 1

    db.commit()

    return {
        "created_requests_count": len(created_requests),
        "created_supplier_orders_count": supplier_orders_created,
        "request_ids": [r.id for r in created_requests],
    }
