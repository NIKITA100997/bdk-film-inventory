import datetime as dt

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.dictionaries import Color, Manufacturer, Material, MaterialSku, Thickness
from app.models.events import EventType, MaterialEvent
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.schemas.reports import DonorAccuracyOut, MovementEntry, StockByWidthLine, StockSummaryLine

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/stock-summary", response_model=list[StockSummaryLine])
def stock_summary(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[StockSummaryLine]:
    """Остатки по материалу/цвету/толщине, м² (5.4 ТЗ) — без учёта
    производителя, как и заявка на плёнку (2.7)."""
    rows = (
        db.query(
            Material.name,
            Color.name,
            Thickness.value_mm,
            func.sum(MaterialUnit.width_mm * MaterialUnit.length_m / 1000).label("area"),
            func.count(MaterialUnit.id).label("unit_count"),
        )
        .join(MaterialSku, MaterialUnit.material_sku_id == MaterialSku.id)
        .join(Material, MaterialSku.material_id == Material.id)
        .join(Color, MaterialSku.color_id == Color.id)
        .join(Thickness, MaterialSku.thickness_id == Thickness.id)
        .filter(MaterialUnit.status != UnitStatus.SPISAN)
        .group_by(Material.name, Color.name, Thickness.value_mm)
        .order_by(Material.name, Color.name, Thickness.value_mm)
        .all()
    )
    return [
        StockSummaryLine(material=m, color=c, thickness=float(t), total_area_m2=round(float(area or 0), 3), unit_count=cnt)
        for m, c, t, area, cnt in rows
    ]


@router.get("/stock-by-width", response_model=list[StockByWidthLine])
def stock_by_width(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[StockByWidthLine]:
    """Остатки по конкретной ширине, метры (5.4 ТЗ)."""
    rows = (
        db.query(
            Material.name,
            Color.name,
            Thickness.value_mm,
            Manufacturer.name,
            MaterialUnit.width_mm,
            func.sum(MaterialUnit.length_m).label("total_length_m"),
            func.count(MaterialUnit.id).label("unit_count"),
        )
        .join(MaterialSku, MaterialUnit.material_sku_id == MaterialSku.id)
        .join(Material, MaterialSku.material_id == Material.id)
        .join(Color, MaterialSku.color_id == Color.id)
        .join(Thickness, MaterialSku.thickness_id == Thickness.id)
        .join(Manufacturer, MaterialSku.manufacturer_id == Manufacturer.id)
        .filter(MaterialUnit.status != UnitStatus.SPISAN)
        .group_by(Material.name, Color.name, Thickness.value_mm, Manufacturer.name, MaterialUnit.width_mm)
        .order_by(Material.name, Color.name, Thickness.value_mm, MaterialUnit.width_mm.desc())
        .all()
    )
    return [
        StockByWidthLine(
            material=m,
            color=c,
            thickness=float(t),
            manufacturer=mf,
            width_mm=float(w),
            total_length_m=round(float(length or 0), 3),
            unit_count=cnt,
        )
        for m, c, t, mf, w, length, cnt in rows
    ]


@router.get("/movement", response_model=list[MovementEntry])
def movement(
    date_from: dt.date = Query(...),
    date_to: dt.date = Query(...),
    material_sku_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MovementEntry]:
    """Движение за период (5.4 ТЗ) — журнал событий по всем позициям, с
    опциональным фильтром по одной позиции материала."""
    query = (
        db.query(MaterialEvent, Material.name, Color.name, Thickness.value_mm, Manufacturer.name)
        .join(MaterialSku, MaterialEvent.material_sku_id == MaterialSku.id)
        .join(Material, MaterialSku.material_id == Material.id)
        .join(Color, MaterialSku.color_id == Color.id)
        .join(Thickness, MaterialSku.thickness_id == Thickness.id)
        .join(Manufacturer, MaterialSku.manufacturer_id == Manufacturer.id)
        .filter(func.date(MaterialEvent.timestamp) >= date_from, func.date(MaterialEvent.timestamp) <= date_to)
    )
    if material_sku_id is not None:
        query = query.filter(MaterialEvent.material_sku_id == material_sku_id)
    rows = query.order_by(MaterialEvent.timestamp.desc()).limit(500).all()

    return [
        MovementEntry(
            event_id=ev.event_id,
            unit_id=ev.unit_id,
            material=m,
            color=c,
            thickness=float(t),
            manufacturer=mf,
            event_type=ev.event_type.value,
            area=ev.area.value if ev.area else None,
            timestamp=ev.timestamp,
            width_mm=float(ev.width_mm),
            quantity_delta_m=float(ev.quantity_delta_m),
        )
        for ev, m, c, t, mf in rows
    ]


@router.get("/donor-accuracy", response_model=DonorAccuracyOut)
def donor_accuracy(
    date_from: dt.date = Query(...),
    date_to: dt.date = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DonorAccuracyOut:
    """Точность донор-рекомендаций (5.5 ТЗ) — доля предложенных доноров,
    которые оператор реально пустил в резку (Продольная_резка после
    Донор_предложен на той же единице)."""
    suggestions = (
        db.query(MaterialEvent.unit_id, MaterialEvent.timestamp)
        .filter(
            MaterialEvent.event_type == EventType.DONOR_PREDLOZHEN,
            func.date(MaterialEvent.timestamp) >= date_from,
            func.date(MaterialEvent.timestamp) <= date_to,
        )
        .all()
    )
    accepted = 0
    for unit_id, ts in suggestions:
        was_cut = (
            db.query(MaterialEvent.event_id)
            .filter(
                MaterialEvent.unit_id == unit_id,
                MaterialEvent.event_type == EventType.PRODOLNAYA_REZKA,
                MaterialEvent.timestamp >= ts,
            )
            .first()
        )
        if was_cut:
            accepted += 1

    suggested = len(suggestions)
    return DonorAccuracyOut(
        period_from=date_from,
        period_to=date_to,
        suggested=suggested,
        accepted=accepted,
        accuracy_percent=round(accepted / suggested * 100, 1) if suggested else 0,
    )
