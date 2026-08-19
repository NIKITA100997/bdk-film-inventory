import datetime as dt
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.abc import CalcSettings
from app.models.areas import Area
from app.models.dictionaries import Color, Manufacturer, Material, MaterialSku, Thickness
from app.models.events import EventType, MaterialEvent
from app.models.production import (
    ProductionLine,
    ProductionTask,
    ProductionTaskLine,
    ProductionTaskLineAssignment,
    ProductionTaskLineReport,
    ProductModel,
)
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.models.write_off_reasons import WriteOffReasonEntry
from app.schemas.reports import (
    CuttingDiscrepancyLine,
    DefectPivotOut,
    DefectPivotRowOut,
    DefectsOverviewOut,
    DonorAccuracyOut,
    MovementEntry,
    ProductionDefectLine,
    ReasonShareLine,
    StaleUnitLine,
    StockByWidthLine,
    StockSummaryLine,
    TopDefectGroupLine,
    TopWriteOffMaterialLine,
    TrendPoint,
    WriteOffLine,
)
from app.services.defects_reports import PivotInputRow, build_defect_pivot, bucket_date_range, defect_rate_percent, delta_percent

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
    user: User = Depends(require_permission("reports.view")),
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
    user: User = Depends(require_permission("reports.view")),
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


@router.get("/stale-units", response_model=list[StaleUnitLine])
def stale_units(
    threshold_days: int | None = Query(default=None, gt=0),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("reports.view")),
) -> list[StaleUnitLine]:
    """«Давно не двигались» (5 раздел бэклога доработок) — единицы На_хранении
    без единого события дольше threshold_days (по умолчанию из CalcSettings).
    Сигнал на внеплановую ревизию/инвентаризацию, не блокирует работу."""
    settings = db.get(CalcSettings, 1)
    days = threshold_days or (settings.stale_threshold_days if settings else 60)
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)

    rows = (
        db.query(Material.name, Color.name, Thickness.value_mm, Manufacturer.name, MaterialUnit)
        .join(MaterialSku, MaterialUnit.material_sku_id == MaterialSku.id)
        .join(Material, MaterialSku.material_id == Material.id)
        .join(Color, MaterialSku.color_id == Color.id)
        .join(Thickness, MaterialSku.thickness_id == Thickness.id)
        .join(Manufacturer, MaterialSku.manufacturer_id == Manufacturer.id)
        .filter(MaterialUnit.status == UnitStatus.NA_KHRANENII, MaterialUnit.updated_at < cutoff)
        .order_by(MaterialUnit.updated_at.asc())
        .limit(500)
        .all()
    )

    now = dt.datetime.now(dt.timezone.utc)
    return [
        StaleUnitLine(
            unit_id=unit.id,
            material=m,
            color=c,
            thickness=float(t),
            manufacturer=mf,
            width_mm=float(unit.width_mm),
            length_m=float(unit.length_m),
            location_code=unit.location_code,
            last_moved_at=unit.updated_at,
            days_idle=(now - unit.updated_at).days,
        )
        for m, c, t, mf, unit in rows
    ]


@router.get("/cutting-discrepancies", response_model=list[CuttingDiscrepancyLine])
def cutting_discrepancies(
    date_from: dt.date = Query(...),
    date_to: dt.date = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("reports.view")),
) -> list[CuttingDiscrepancyLine]:
    """Отклонения при резке по плану (раздел про несколько ширин за
    проход) — где контрольная длина, введённая по факту резки
    (/units/cutting-plan/execute), заметно отличается от теоретической
    (expected_length_m, записывается только событиями этого действия).
    Тот же допуск (5%, не меньше 0.1 м), что уже применяется при
    исполнении плана и при возврате остатка — единственное место, где он
    считается на бэкенде для отчётности."""
    rows = (
        db.query(
            MaterialEvent,
            Material.name,
            Color.name,
            Thickness.value_mm,
            ProductionTask.area,
            ProductModel.name,
            ProductionTask.name,
            ProductionTaskLine.part_name,
        )
        .join(MaterialSku, MaterialEvent.material_sku_id == MaterialSku.id)
        .join(Material, MaterialSku.material_id == Material.id)
        .join(Color, MaterialSku.color_id == Color.id)
        .join(Thickness, MaterialSku.thickness_id == Thickness.id)
        .outerjoin(ProductionTaskLine, MaterialEvent.production_task_line_id == ProductionTaskLine.id)
        .outerjoin(ProductionTask, ProductionTaskLine.task_id == ProductionTask.id)
        .outerjoin(ProductModel, ProductionTask.product_model_id == ProductModel.id)
        .filter(
            MaterialEvent.event_type == EventType.VYDACHA_UCHASTKU,
            MaterialEvent.expected_length_m.isnot(None),
            func.date(MaterialEvent.timestamp) >= date_from,
            func.date(MaterialEvent.timestamp) <= date_to,
        )
        .order_by(MaterialEvent.timestamp.desc())
        .limit(500)
        .all()
    )

    result: list[CuttingDiscrepancyLine] = []
    for ev, material, color, thickness, area, model_name, task_name, part_name in rows:
        expected = float(ev.expected_length_m)
        actual = float(ev.to_length) if ev.to_length is not None else 0.0
        discrepancy_m = actual - expected
        tolerance = max(0.1, expected * 0.05)
        if abs(discrepancy_m) <= tolerance:
            continue
        result.append(
            CuttingDiscrepancyLine(
                event_id=ev.event_id,
                unit_id=ev.unit_id,
                area=area,
                task_name=model_name or task_name,
                part_name=part_name,
                material=material,
                color=color,
                thickness=float(thickness),
                expected_length_m=expected,
                actual_length_m=actual,
                discrepancy_m=round(discrepancy_m, 3),
                discrepancy_percent=round(discrepancy_m / expected * 100, 1) if expected else 0.0,
                timestamp=ev.timestamp,
                user_id=ev.user_id,
            )
        )
    return result


# ================= Раздел про модуль "Брак и списания" =================


@router.get("/write-offs", response_model=list[WriteOffLine])
def write_offs(
    date_from: dt.date = Query(...),
    date_to: dt.date = Query(...),
    material_sku_id: int | None = None,
    reason: str | None = None,
    include_cutting_waste: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("reports.view")),
) -> list[WriteOffLine]:
    """Списания по складу — журнал SPISANIE-событий с причиной/заметкой/
    кем. "Отход при раскрое" (системная причина) по умолчанию скрыт — это
    рутинный технологический отход, не проблема, засоряет анализ реального
    брака (include_cutting_waste=True его возвращает)."""
    query = (
        db.query(MaterialEvent, Material.name, Color.name, Thickness.value_mm, WriteOffReasonEntry, User.full_name)
        .join(MaterialSku, MaterialEvent.material_sku_id == MaterialSku.id)
        .join(Material, MaterialSku.material_id == Material.id)
        .join(Color, MaterialSku.color_id == Color.id)
        .join(Thickness, MaterialSku.thickness_id == Thickness.id)
        .outerjoin(WriteOffReasonEntry, MaterialEvent.write_off_reason == WriteOffReasonEntry.code)
        .join(User, MaterialEvent.user_id == User.id)
        .filter(
            MaterialEvent.event_type == EventType.SPISANIE,
            func.date(MaterialEvent.timestamp) >= date_from,
            func.date(MaterialEvent.timestamp) <= date_to,
        )
    )
    if material_sku_id is not None:
        query = query.filter(MaterialEvent.material_sku_id == material_sku_id)
    if reason is not None:
        query = query.filter(MaterialEvent.write_off_reason == reason)
    if not include_cutting_waste:
        query = query.filter(WriteOffReasonEntry.is_system.is_(False) | WriteOffReasonEntry.is_system.is_(None))
    rows = query.order_by(MaterialEvent.timestamp.desc()).limit(500).all()

    return [
        WriteOffLine(
            event_id=ev.event_id,
            unit_id=ev.unit_id,
            timestamp=ev.timestamp,
            material=m,
            color=c,
            thickness=float(t),
            width_mm=float(ev.width_mm),
            quantity_m=round(-float(ev.quantity_delta_m), 3),
            reason_code=reason_entry.code if reason_entry else None,
            reason_name=reason_entry.name if reason_entry else None,
            note=ev.write_off_note,
            user_name=user_name,
            is_cutting_waste=bool(reason_entry and reason_entry.is_system),
        )
        for ev, m, c, t, reason_entry, user_name in rows
    ]


@router.get("/production-defects", response_model=list[ProductionDefectLine])
def production_defects(
    date_from: dt.date = Query(...),
    date_to: dt.date = Query(...),
    area: str | None = None,
    line_id: int | None = None,
    task_id: int | None = None,
    reason: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("reports.view")),
) -> list[ProductionDefectLine]:
    """Брак на производстве — построчный журнал ProductionTaskLineReport,
    только записи с реальным браком (defect_pieces > 0). Линия — только у
    отчётов, привязанных к конкретному распределению (assignment_id);
    старые отчёты без неё показывают участок, но не линию."""
    query = (
        db.query(
            ProductionTaskLineReport,
            ProductionTask.id,
            ProductModel.name,
            ProductionTask.name,
            ProductionTaskLine.part_name,
            ProductionTask.area,
            Area.name,
            ProductionTaskLineAssignment.line_id,
            ProductionLine.name,
            WriteOffReasonEntry.name,
            User.full_name,
        )
        .join(ProductionTaskLine, ProductionTaskLineReport.task_line_id == ProductionTaskLine.id)
        .join(ProductionTask, ProductionTaskLine.task_id == ProductionTask.id)
        .outerjoin(ProductModel, ProductionTask.product_model_id == ProductModel.id)
        .join(Area, ProductionTask.area == Area.code)
        .outerjoin(
            ProductionTaskLineAssignment, ProductionTaskLineReport.assignment_id == ProductionTaskLineAssignment.id
        )
        .outerjoin(ProductionLine, ProductionTaskLineAssignment.line_id == ProductionLine.id)
        .outerjoin(WriteOffReasonEntry, ProductionTaskLineReport.defect_reason == WriteOffReasonEntry.code)
        .join(User, ProductionTaskLineReport.reported_by == User.id)
        .filter(
            ProductionTaskLineReport.defect_pieces > 0,
            func.date(ProductionTaskLineReport.reported_at) >= date_from,
            func.date(ProductionTaskLineReport.reported_at) <= date_to,
        )
    )
    if area is not None:
        query = query.filter(ProductionTask.area == area)
    if line_id is not None:
        query = query.filter(ProductionTaskLineAssignment.line_id == line_id)
    if task_id is not None:
        query = query.filter(ProductionTask.id == task_id)
    if reason is not None:
        query = query.filter(ProductionTaskLineReport.defect_reason == reason)

    rows = query.order_by(ProductionTaskLineReport.reported_at.desc()).limit(500).all()

    return [
        ProductionDefectLine(
            report_id=report.id,
            reported_at=report.reported_at,
            task_id=t_id,
            task_name=model_name or task_name,
            part_name=part_name,
            area=area_code,
            area_name=area_name,
            line_id=line_id_,
            line_name=line_name,
            defect_pieces=float(report.defect_pieces),
            good_pieces=float(report.good_pieces),
            reason_code=report.defect_reason,
            reason_name=reason_name,
            note=report.note,
            reported_by_name=reported_by_name,
        )
        for report, t_id, model_name, task_name, part_name, area_code, area_name, line_id_, line_name, reason_name, reported_by_name in rows
    ]


def _fetch_pivot_rows(
    db: Session, date_from: dt.date, date_to: dt.date, group_by: Literal["detail", "area", "line"]
) -> list[PivotInputRow]:
    """Плоский список отчётов о производстве за период, с уже
    подтянутыми подписями для выбранного разреза — агрегирует их дальше
    build_defect_pivot (app/services/defects_reports.py), чистая функция,
    независимая от запроса."""
    query = (
        db.query(
            ProductionTaskLineReport.defect_pieces,
            ProductionTaskLineReport.good_pieces,
            WriteOffReasonEntry.name,
            ProductionTaskLine.part_name,
            ProductionTask.area,
            Area.name,
            ProductionTaskLineAssignment.line_id,
            ProductionLine.name,
        )
        .join(ProductionTaskLine, ProductionTaskLineReport.task_line_id == ProductionTaskLine.id)
        .join(ProductionTask, ProductionTaskLine.task_id == ProductionTask.id)
        .join(Area, ProductionTask.area == Area.code)
        .outerjoin(
            ProductionTaskLineAssignment, ProductionTaskLineReport.assignment_id == ProductionTaskLineAssignment.id
        )
        .outerjoin(ProductionLine, ProductionTaskLineAssignment.line_id == ProductionLine.id)
        .outerjoin(WriteOffReasonEntry, ProductionTaskLineReport.defect_reason == WriteOffReasonEntry.code)
        .filter(
            func.date(ProductionTaskLineReport.reported_at) >= date_from,
            func.date(ProductionTaskLineReport.reported_at) <= date_to,
        )
    )
    rows: list[PivotInputRow] = []
    for defect, good, reason_name, part_name, area_code, area_name, line_id, line_name in query.all():
        if group_by == "detail":
            key, label, parent = part_name or "detail:none", part_name or "Без названия", None
        elif group_by == "area":
            key, label, parent = area_code, area_name, None
        else:  # "line"
            if line_id is None:
                continue
            key, label, parent = f"line:{line_id}", line_name, area_name
        rows.append(
            PivotInputRow(
                group_key=str(key),
                group_label=label,
                parent_label=parent,
                reason_name=reason_name,
                defect_pieces=float(defect),
                good_pieces=float(good),
            )
        )
    return rows


def _top_defect_groups(db: Session, date_from: dt.date, date_to: dt.date, limit: int = 6) -> list[TopDefectGroupLine]:
    """Худшие по доле брака — участки и линии одним списком (раздел
    "Обзор"), переиспользует ту же агрегацию, что и сама сводная таблица."""
    area_pivot = build_defect_pivot(_fetch_pivot_rows(db, date_from, date_to, "area"))
    line_pivot = build_defect_pivot(_fetch_pivot_rows(db, date_from, date_to, "line"))
    combined = [
        TopDefectGroupLine(
            level="area",
            label=g.group_label,
            parent_label=None,
            defect_pieces=g.defect_pieces,
            good_pieces=g.good_pieces,
            defect_rate_percent=g.defect_rate_percent,
        )
        for g in area_pivot.rows
    ] + [
        TopDefectGroupLine(
            level="line",
            label=g.group_label,
            parent_label=g.parent_label,
            defect_pieces=g.defect_pieces,
            good_pieces=g.good_pieces,
            defect_rate_percent=g.defect_rate_percent,
        )
        for g in line_pivot.rows
    ]
    combined.sort(key=lambda g: g.defect_rate_percent, reverse=True)
    return combined[:limit]


@router.get("/defects-pivot", response_model=DefectPivotOut)
def defects_pivot(
    date_from: dt.date = Query(...),
    date_to: dt.date = Query(...),
    group_by: Literal["detail", "area", "line"] = Query("detail"),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("reports.view")),
) -> DefectPivotOut:
    """Сводная таблица брака на производстве — по деталям/участкам/линиям,
    с причинами по столбцам и строкой итого."""
    pivot = build_defect_pivot(_fetch_pivot_rows(db, date_from, date_to, group_by))
    return DefectPivotOut(
        group_by=group_by,
        reasons=pivot.reasons,
        rows=[
            DefectPivotRowOut(
                group_label=g.group_label,
                parent_label=g.parent_label,
                by_reason=g.by_reason,
                defect_pieces=g.defect_pieces,
                good_pieces=g.good_pieces,
                defect_rate_percent=g.defect_rate_percent,
            )
            for g in pivot.rows
        ],
        total=DefectPivotRowOut(
            group_label=pivot.total.group_label,
            parent_label=None,
            by_reason=pivot.total.by_reason,
            defect_pieces=pivot.total.defect_pieces,
            good_pieces=pivot.total.good_pieces,
            defect_rate_percent=pivot.total.defect_rate_percent,
        ),
    )


@router.get("/defects-trend", response_model=list[TrendPoint])
def defects_trend(
    date_from: dt.date = Query(...),
    date_to: dt.date = Query(...),
    bucket_days: int = Query(7, gt=0),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("reports.view")),
) -> list[TrendPoint]:
    """Динамика по бакетам (по умолчанию — неделям) — списания склада, м, и
    брак на производстве, шт, рядом для сравнения масштаба."""
    points: list[TrendPoint] = []
    for start, end in bucket_date_range(date_from, date_to, bucket_days):
        warehouse_m = (
            db.query(func.coalesce(func.sum(-MaterialEvent.quantity_delta_m), 0))
            .filter(
                MaterialEvent.event_type == EventType.SPISANIE,
                func.date(MaterialEvent.timestamp) >= start,
                func.date(MaterialEvent.timestamp) <= end,
            )
            .scalar()
        )
        production_pieces = (
            db.query(func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0))
            .filter(
                func.date(ProductionTaskLineReport.reported_at) >= start,
                func.date(ProductionTaskLineReport.reported_at) <= end,
            )
            .scalar()
        )
        label = f"{start.strftime('%d.%m')}–{end.strftime('%d.%m')}" if start != end else start.strftime("%d.%m")
        points.append(
            TrendPoint(
                period_from=start,
                period_to=end,
                label=label,
                warehouse_m=round(float(warehouse_m), 2),
                production_defect_pieces=float(production_pieces),
            )
        )
    return points


@router.get("/defects-overview", response_model=DefectsOverviewOut)
def defects_overview(
    date_from: dt.date = Query(...),
    date_to: dt.date = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("reports.view")),
) -> DefectsOverviewOut:
    """KPI обзора модуля "Брак и списания" — склад (SPISANIE, с отдельной
    цифрой на рутинный отход при раскрое) и производство (брак по
    отчётам), с изменением к предыдущему периоду той же длины."""
    period_days = (date_to - date_from).days + 1
    prev_date_to = date_from - dt.timedelta(days=1)
    prev_date_from = prev_date_to - dt.timedelta(days=period_days - 1)

    def warehouse_totals(d_from: dt.date, d_to: dt.date) -> tuple[float, float, int]:
        total, cutting_waste, count = (
            db.query(
                func.coalesce(func.sum(-MaterialEvent.quantity_delta_m), 0),
                func.coalesce(
                    func.sum(case((WriteOffReasonEntry.is_system.is_(True), -MaterialEvent.quantity_delta_m), else_=0)),
                    0,
                ),
                func.count(MaterialEvent.event_id),
            )
            .outerjoin(WriteOffReasonEntry, MaterialEvent.write_off_reason == WriteOffReasonEntry.code)
            .filter(
                MaterialEvent.event_type == EventType.SPISANIE,
                func.date(MaterialEvent.timestamp) >= d_from,
                func.date(MaterialEvent.timestamp) <= d_to,
            )
            .one()
        )
        return float(total), float(cutting_waste), int(count)

    def production_totals(d_from: dt.date, d_to: dt.date) -> tuple[float, float]:
        defect, good = (
            db.query(
                func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0),
                func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
            )
            .filter(
                func.date(ProductionTaskLineReport.reported_at) >= d_from,
                func.date(ProductionTaskLineReport.reported_at) <= d_to,
            )
            .one()
        )
        return float(defect), float(good)

    warehouse_total, warehouse_cutting_waste, warehouse_events = warehouse_totals(date_from, date_to)
    prev_warehouse_total, prev_warehouse_cutting_waste, _ = warehouse_totals(prev_date_from, prev_date_to)
    warehouse_real_defect = warehouse_total - warehouse_cutting_waste
    prev_warehouse_real_defect = prev_warehouse_total - prev_warehouse_cutting_waste

    production_defect, production_good = production_totals(date_from, date_to)
    prev_production_defect, _ = production_totals(prev_date_from, prev_date_to)

    warehouse_reason_rows = (
        db.query(WriteOffReasonEntry.name, func.sum(-MaterialEvent.quantity_delta_m))
        .join(WriteOffReasonEntry, MaterialEvent.write_off_reason == WriteOffReasonEntry.code)
        .filter(
            MaterialEvent.event_type == EventType.SPISANIE,
            WriteOffReasonEntry.is_system.is_(False),
            func.date(MaterialEvent.timestamp) >= date_from,
            func.date(MaterialEvent.timestamp) <= date_to,
        )
        .group_by(WriteOffReasonEntry.name)
        .order_by(func.sum(-MaterialEvent.quantity_delta_m).desc())
        .all()
    )
    warehouse_reason_total = sum(float(a) for _, a in warehouse_reason_rows) or 1.0
    warehouse_reasons = [
        ReasonShareLine(
            reason_name=name, amount=round(float(amount), 2), share_percent=round(float(amount) / warehouse_reason_total * 100, 1)
        )
        for name, amount in warehouse_reason_rows
    ]

    # Один и тот же Python-объект выражения в SELECT и GROUP BY — иначе
    # Postgres видит два разных COALESCE(...) (разные bind-параметры на
    # "Без причины", хоть и с одинаковым значением) и требует
    # write_off_reasons.name в GROUP BY отдельно (GroupingError).
    reason_label = func.coalesce(WriteOffReasonEntry.name, "Без причины")
    production_reason_rows = (
        db.query(reason_label, func.sum(ProductionTaskLineReport.defect_pieces))
        .select_from(ProductionTaskLineReport)
        .outerjoin(WriteOffReasonEntry, ProductionTaskLineReport.defect_reason == WriteOffReasonEntry.code)
        .filter(
            ProductionTaskLineReport.defect_pieces > 0,
            func.date(ProductionTaskLineReport.reported_at) >= date_from,
            func.date(ProductionTaskLineReport.reported_at) <= date_to,
        )
        .group_by(reason_label)
        .order_by(func.sum(ProductionTaskLineReport.defect_pieces).desc())
        .all()
    )
    production_reason_total = sum(float(a) for _, a in production_reason_rows) or 1.0
    production_reasons = [
        ReasonShareLine(
            reason_name=name, amount=round(float(amount), 1), share_percent=round(float(amount) / production_reason_total * 100, 1)
        )
        for name, amount in production_reason_rows
    ]

    top_material_rows = (
        db.query(
            Material.name,
            Color.name,
            Thickness.value_mm,
            func.sum(-MaterialEvent.quantity_delta_m),
            func.count(MaterialEvent.event_id),
        )
        .join(MaterialSku, MaterialEvent.material_sku_id == MaterialSku.id)
        .join(Material, MaterialSku.material_id == Material.id)
        .join(Color, MaterialSku.color_id == Color.id)
        .join(Thickness, MaterialSku.thickness_id == Thickness.id)
        .join(WriteOffReasonEntry, MaterialEvent.write_off_reason == WriteOffReasonEntry.code)
        .filter(
            MaterialEvent.event_type == EventType.SPISANIE,
            WriteOffReasonEntry.is_system.is_(False),
            func.date(MaterialEvent.timestamp) >= date_from,
            func.date(MaterialEvent.timestamp) <= date_to,
        )
        .group_by(Material.name, Color.name, Thickness.value_mm)
        .order_by(func.sum(-MaterialEvent.quantity_delta_m).desc())
        .limit(5)
        .all()
    )
    top_materials = [
        TopWriteOffMaterialLine(material=m, color=c, thickness=float(t), amount_m=round(float(amount), 2), events=int(cnt))
        for m, c, t, amount, cnt in top_material_rows
    ]

    return DefectsOverviewOut(
        period_from=date_from,
        period_to=date_to,
        warehouse_total_m=round(warehouse_total, 2),
        warehouse_total_m_delta_percent=delta_percent(warehouse_total, prev_warehouse_total),
        warehouse_cutting_waste_m=round(warehouse_cutting_waste, 2),
        warehouse_real_defect_m=round(warehouse_real_defect, 2),
        warehouse_real_defect_m_delta_percent=delta_percent(warehouse_real_defect, prev_warehouse_real_defect),
        warehouse_events_count=warehouse_events,
        production_defect_pieces=production_defect,
        production_defect_pieces_delta_percent=delta_percent(production_defect, prev_production_defect),
        production_good_pieces=production_good,
        production_defect_rate_percent=defect_rate_percent(production_defect, production_good),
        warehouse_reasons=warehouse_reasons,
        production_reasons=production_reasons,
        top_materials=top_materials,
        top_defect_groups=_top_defect_groups(db, date_from, date_to),
    )
