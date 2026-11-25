"""Сервис сверки рулонов на окутке — сборка снимка единицы, привязанной
строки задания и итогов отчётов по ней."""

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.dictionaries import Color
from app.models.events import EventType, MaterialEvent
from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.units import MaterialUnit, UnitStatus
from app.schemas.units import ReconciliationRowOut


def list_reconciliation_rows(
    db: Session,
    *,
    area: str | None = None,
    only_attention: bool = False,
    unit_id: int | None = None,
) -> list[ReconciliationRowOut]:
    """Сборка строк панели сверки рулонов (или одной карточки по unit_id)."""
    query = (
        db.query(MaterialUnit)
        .outerjoin(ProductionTaskLine, MaterialUnit.production_task_line_id == ProductionTaskLine.id)
        .outerjoin(ProductionTask, ProductionTaskLine.task_id == ProductionTask.id)
    )
    if unit_id is not None:
        query = query.filter(MaterialUnit.id == unit_id)
    else:
        query = query.filter(MaterialUnit.status.in_([UnitStatus.VYDAN_UCHASTKU, UnitStatus.NA_KHRANENII]))
        if area is not None:
            query = query.filter(or_(MaterialUnit.area == area, ProductionTask.area == area))
    units = query.order_by(MaterialUnit.updated_at.desc()).limit(500).all()

    report_aggs: dict[int, tuple[int, float, float]] = {}
    unit_ids = [u.id for u in units]
    if unit_ids:
        # Для рулонов, находящихся сейчас на участке (status == VYDAN_UCHASTKU),
        # отчётами текущей выдачи считаются только отчёты, поданные не раньше момента
        # последней выдачи этого рулона участку. Отчёты прошлых выдач (по старым заданиям
        # или закрытым строкам) не должны примешиваться к текущему состоянию рулона.
        last_issue_subq = (
            db.query(
                MaterialEvent.unit_id.label("event_unit_id"),
                func.max(MaterialEvent.timestamp).label("last_issued_at"),
            )
            .filter(
                MaterialEvent.unit_id.in_(unit_ids),
                MaterialEvent.event_type == EventType.VYDACHA_UCHASTKU,
            )
            .group_by(MaterialEvent.unit_id)
            .subquery()
        )
        agg_rows = (
            db.query(
                ProductionTaskLineReport.material_unit_id,
                func.count(ProductionTaskLineReport.id),
                func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
                func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0),
            )
            .join(MaterialUnit, MaterialUnit.id == ProductionTaskLineReport.material_unit_id)
            .outerjoin(last_issue_subq, last_issue_subq.c.event_unit_id == MaterialUnit.id)
            # «Отчёты по строке» — по строке, к которой рулон привязан
            # сейчас; отчёты прошлых выдач по другим заданиям сюда не
            # идут (08.10, штрипс №3264 показывал чужие 73 шт)
            .filter(
                ProductionTaskLineReport.material_unit_id.in_(unit_ids),
                ProductionTaskLineReport.task_line_id == MaterialUnit.production_task_line_id,
                or_(
                    MaterialUnit.status != UnitStatus.VYDAN_UCHASTKU,
                    last_issue_subq.c.last_issued_at.is_(None),
                    ProductionTaskLineReport.reported_at >= last_issue_subq.c.last_issued_at,
                ),
            )
            .group_by(ProductionTaskLineReport.material_unit_id)
            .all()
        )
        report_aggs = {uid: (cnt, float(good), float(defect)) for uid, cnt, good, defect in agg_rows}

    color_ids = {u.production_task_line.color_id for u in units if u.production_task_line and u.production_task_line.color_id}
    colors_map = {c.id: c for c in db.query(Color).filter(Color.id.in_(color_ids)).all()} if color_ids else {}

    out: list[ReconciliationRowOut] = []
    for u in units:
        line = u.production_task_line
        task_label = None
        if line is not None:
            color = colors_map.get(line.color_id) if line.color_id else None
            order_ref = (
                f"№{line.task.external_order_ref}" if line.task.external_order_ref
                else (line.task.name or f"#{line.task.id}")
            )
            task_label = f"{order_ref} — {line.part_name or ''} {color.name if color else ''}".strip()
        cnt, good, defect = report_aggs.get(u.id, (0, 0.0, 0.0))
        if only_attention:
            needs_attention = (line is None and not u.legacy_task_note) or (line is not None and cnt == 0)
            if not needs_attention:
                continue
        out.append(
            ReconciliationRowOut(
                unit_id=u.id,
                width_mm=float(u.width_mm),
                length_m=float(u.length_m),
                status=u.status,
                area=u.area,
                location_code=u.location_code,
                legacy_task_note=u.legacy_task_note,
                task_line_id=line.id if line else None,
                task_area=line.task.area if line else None,
                task_label=task_label,
                task_quantity_pieces=float(line.quantity_pieces) if line else None,
                task_length_m=float(line.length_m) if line else None,
                reports_count=cnt,
                good_pieces_sum=good,
                defect_pieces_sum=defect,
            )
        )
    return out
