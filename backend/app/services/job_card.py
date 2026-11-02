"""Сервис формирования сменного наряда-задания / маршрутной карты на станок (Job Card).

Предоставляет готовую для планшета и печати А4 структуру сменного задания:
- Шапка наряда с номером заказа, заказчиком, сроком и участком
- QR-код для моментального сканирования камерой планшета в FastReportPanel
- Сводка по сырью и плёнке с расчетным метражом (+5% техзапас) и закрепленными рулонами
- Детализация по деталям: размеры (Д x Ш x Т мм), ширина штрипса, ЧПУ программа, план/факт
- Связанные задания ПФ / родительские задания
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from sqlalchemy.orm import Session
from app.models.areas import Area
from app.models.production import ProductionTask
from app.models.production_orders import ProductionOrder
from app.schemas.production import (
    JobCardLineOut,
    JobCardMaterialOut,
    JobCardOut,
    JobCardRelatedTaskOut,
    ProductionTaskOut,
)


def build_job_card(
    db: Session,
    task: ProductionTask,
    task_out: ProductionTaskOut,
) -> JobCardOut:
    """Формирует полную модель маршрутной карты / наряда-задания."""
    area = db.get(Area, task.area)
    area_name = area.name if area else task.area

    order = (
        db.get(ProductionOrder, task.production_order_id)
        if task.production_order_id
        else None
    )
    order_name = order.name if order else None
    order_note = order.note if order else None
    deadline_date = order.ship_date if order else None

    # Строки и итоговые количества
    lines_out: list[JobCardLineOut] = []
    total_qty = 0.0
    total_good = 0.0
    total_defects = 0.0
    total_remaining = 0.0
    line_names_list: list[str] = []

    # Группировка материалов: (material, color, thickness, strip_width_mm) -> dict
    materials_map: dict[tuple, dict] = {}

    for l in task_out.lines:
        total_qty += l.quantity_pieces
        total_good += l.produced_good_pieces
        total_defects += l.defect_pieces
        total_remaining += l.remaining_pieces

        if l.line_name and l.line_name != "Не назначена":
            line_names_list.append(l.line_name)

        len_mm = round(l.length_m * 1000, 1)
        w_mm = round(l.width_mm, 1)
        th_mm = round(l.thickness, 2) if l.thickness else None

        dims_str = f"{int(len_mm)} x {int(w_mm)}"
        if th_mm:
            dims_str += f" x {th_mm:g}"
        dims_str += " мм"

        # Метка материала/декора
        mat_parts: list[str] = []
        if l.color:
            mat_parts.append(l.color)
        if l.material:
            mat_parts.append(l.material)
        if l.strip_width_mm:
            mat_parts.append(f"штрипс {int(l.strip_width_mm)}мм")
        mat_label = " · ".join(mat_parts) if mat_parts else "—"

        lines_out.append(
            JobCardLineOut(
                id=l.id,
                line_id=l.line_id,
                line_name=l.line_name,
                part_name=l.part_name,
                operation_name=l.operation_name,
                dimensions=dims_str,
                length_mm=len_mm,
                width_mm=w_mm,
                thickness_mm=th_mm,
                strip_width_mm=l.strip_width_mm,
                material_label=mat_label,
                program=l.program,
                instruction=l.instruction,
                quantity_pieces=l.quantity_pieces,
                produced_good_pieces=l.produced_good_pieces,
                defect_pieces=l.defect_pieces,
                remaining_pieces=l.remaining_pieces,
                production_closed=l.production_closed,
            )
        )

        # Сводка сырья и плёнки
        if l.color or l.material or l.strip_width_mm:
            mat_key = (
                l.material or "",
                l.color or "",
                round(l.thickness, 2) if l.thickness else None,
                round(l.strip_width_mm, 1) if l.strip_width_mm else None,
            )
            if mat_key not in materials_map:
                materials_map[mat_key] = {
                    "material": l.material,
                    "color": l.color,
                    "thickness": l.thickness,
                    "strip_width_mm": l.strip_width_mm,
                    "planned_meters": 0.0,
                    "issued_meters": 0.0,
                    "rolls_assigned": set(),
                }
            entry = materials_map[mat_key]
            # +5% технологический запас на заправку и разгон
            planned_m = round(l.quantity_pieces * (l.length_m or 1.0) * 1.05, 2)
            entry["planned_meters"] = round(entry["planned_meters"] + planned_m, 2)
            entry["issued_meters"] = round(entry["issued_meters"] + l.issued_length_m, 2)
            for u in l.issued_units:
                if isinstance(u, dict):
                    roll_id = u.get("id")
                    left = u.get("remaining_length_m", "")
                    entry["rolls_assigned"].add(f"Рулон #{roll_id} ({left}м)")
                elif hasattr(u, "id"):
                    roll_id = u.id
                    left = getattr(u, "remaining_length_m", "")
                    entry["rolls_assigned"].add(f"Рулон #{roll_id} ({left}м)")

    materials_out = [
        JobCardMaterialOut(
            material=m["material"],
            color=m["color"],
            thickness=m["thickness"],
            strip_width_mm=m["strip_width_mm"],
            planned_meters=m["planned_meters"],
            issued_meters=m["issued_meters"],
            rolls_assigned=sorted(list(m["rolls_assigned"])),
        )
        for m in materials_map.values()
    ]

    primary_line_name = line_names_list[0] if line_names_list else None

    completion_pct = (
        round((total_good / total_qty) * 100, 1) if total_qty > 0 else 0.0
    )

    # Связанные задания ПФ
    pf_tasks_out: list[JobCardRelatedTaskOut] = []
    pf_tasks = (
        db.query(ProductionTask)
        .filter(ProductionTask.for_task_id == task.id)
        .order_by(ProductionTask.id)
        .all()
    )
    for pft in pf_tasks:
        pft_area = db.get(Area, pft.area)
        pft_lines = pft.lines
        pft_ready = all(pl.production_closed for pl in pft_lines) if pft_lines else False
        pf_tasks_out.append(
            JobCardRelatedTaskOut(
                id=pft.id,
                name=pft.name,
                area=pft.area,
                area_name=pft_area.name if pft_area else pft.area,
                quantity=pft.quantity,
                is_ready=pft_ready,
            )
        )

    for_task_out = None
    if task.for_task_id:
        parent = db.get(ProductionTask, task.for_task_id)
        if parent:
            parent_area = db.get(Area, parent.area)
            for_task_out = JobCardRelatedTaskOut(
                id=parent.id,
                name=parent.name,
                area=parent.area,
                area_name=parent_area.name if parent_area else parent.area,
                quantity=parent.quantity,
                is_ready=False,
            )

    return JobCardOut(
        task_id=task.id,
        task_name=task.name,
        area_code=task.area,
        area_name=area_name,
        created_at=task.created_at,
        deadline_date=deadline_date,
        order_id=task.production_order_id,
        order_name=order_name,
        order_note=order_note,
        external_order_ref=task.external_order_ref,
        total_quantity=total_qty,
        total_produced_good=total_good,
        total_defects=total_defects,
        total_remaining=total_remaining,
        completion_percent=completion_pct,
        primary_line_name=primary_line_name,
        qr_code_value=f"TASK:{task.id}",
        materials=materials_out,
        lines=lines_out,
        pf_tasks=pf_tasks_out,
        for_task=for_task_out,
    )
