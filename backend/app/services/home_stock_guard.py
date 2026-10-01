"""Запрет лишнего перемещения на склад площадки (30.09): если на складе
назначения (Фабрика) штрипсов нужной плёнки и ширины уже хватает на то,
что ещё нужно открытым заданиям участков этой площадки, — везти туда
плёнку с другого склада нельзя, выдавать надо на месте.

«Хватает» — Σ длины штрипсов/рулонов на хранении на складе назначения
(та же номенклатура, ширина с аналогами) ≥ Σ по открытым строкам заданий
участков площадки (needed − выдано, как в нехватке «Выдачи участку»).
Нет открытых строк под эту плёнку — это пополнение запаса, не запрещаем.
Обойти запрет может только руководитель (users.manage) или
администратор — с обязательным комментарием; кладовщик — нет."""

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import get_permission_codes
from app.models.areas import Area
from app.models.dictionaries import MaterialSku
from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.sites import Site
from app.models.storage import Warehouse
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.services.plan_fact import fetch_issued_length_by_task_line
from app.services.production import calc_default_strip_width
from app.services.warehouses import filter_by_warehouse
from app.services.width_analogs import equivalent_widths


def can_override_home_stock(user: User) -> bool:
    return user.is_superuser or "users.manage" in get_permission_codes(user)


def home_stock_block_reason(db: Session, *, sku_id: int, width_mm: float, to_warehouse_id: int | None) -> str | None:
    """Текст запрета, если на складе to_warehouse_id плёнки уже хватает; иначе None."""
    if to_warehouse_id is None:
        return None
    area_codes = [
        a.code
        for a in db.query(Area).join(Site, Area.site_id == Site.id).filter(Site.warehouse_id == to_warehouse_id, Area.is_active.is_(True))
    ]
    if not area_codes:
        return None
    sku = db.get(MaterialSku, sku_id)
    if sku is None:
        return None
    widths = set(equivalent_widths(db, float(width_mm)))
    lines = [
        ln
        for ln in db.query(ProductionTaskLine)
        .join(ProductionTask, ProductionTaskLine.task_id == ProductionTask.id)
        .filter(
            ProductionTask.is_active.is_(True),
            ProductionTask.area.in_(area_codes),
            ProductionTaskLine.material_id == sku.material_id,
            ProductionTaskLine.color_id == sku.color_id,
            ProductionTaskLine.thickness_id == sku.thickness_id,
            ProductionTaskLine.is_closed.is_(False),
            ProductionTaskLine.production_closed.is_(False),
        )
        if float(ln.strip_width_mm if ln.strip_width_mm is not None else calc_default_strip_width(ln.part_name, float(ln.width_mm)))
        in widths
    ]
    if not lines:
        return None
    ids = [ln.id for ln in lines]
    issued = fetch_issued_length_by_task_line(db, ids)
    reports = dict(
        db.query(ProductionTaskLineReport.task_line_id, func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0))
        .filter(ProductionTaskLineReport.task_line_id.in_(ids))
        .group_by(ProductionTaskLineReport.task_line_id)
        .all()
    )
    need = sum(
        max(0.0, (float(ln.quantity_pieces) + float(reports.get(ln.id, 0))) * float(ln.length_m) - issued.get(ln.id, 0.0))
        for ln in lines
    )
    if need <= 0:
        return None
    stock_q = db.query(MaterialUnit).filter(
        MaterialUnit.status == UnitStatus.NA_KHRANENII,
        MaterialUnit.material_sku_id == sku.id,
        MaterialUnit.width_mm.in_(list(widths)),
    )
    units = filter_by_warehouse(stock_q, MaterialUnit.location_code, db, to_warehouse_id).order_by(MaterialUnit.created_at).all()
    stock = sum(float(u.length_m) for u in units)
    if stock + 1e-6 < need:
        return None
    wh = db.get(Warehouse, to_warehouse_id)
    sample = ", ".join(f"№{u.id} ({float(u.length_m):g} м)" for u in units[:5]) + (" …" if len(units) > 5 else "")
    return (
        f"На складе «{wh.name if wh else to_warehouse_id}» уже хватает: заданиям нужно {need:.1f} м "
        f"{sku.material.name} {sku.color.name} {float(width_mm):g} мм, там лежит {stock:.1f} м — {sample}. "
        f"Выдайте оттуда; перемещать не нужно."
    )
