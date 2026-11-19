"""Исходные позиции заказа, вошедшие в строки заданий участков."""

from collections import defaultdict
import re

from sqlalchemy.orm import Session

from app.models.dictionaries import Part
from app.models.items import Item, ItemComponent
from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineSource
from app.models.production_orders import ProductionOrderLine
from app.services.door_cols import door_cols


def infer_missing_sources(
    db: Session,
    lines: list[ProductionTaskLine],
    result: dict[int, dict[int, float]],
) -> None:
    """Для строк без записей в production_task_line_sources (созданных до внедрения таблицы
    или при ручном/старом объединении) восстанавливает связь с order_line_id
    через дерево компонентов ItemComponent заказа или габариты полуфабрикатов.
    """
    missing_lines = [l for l in lines if l.id and not result.get(l.id) and l.part_id]
    if not missing_lines:
        return

    task_ids = {l.task_id for l in missing_lines}
    tasks = {t.id: t for t in db.query(ProductionTask).filter(ProductionTask.id.in_(task_ids)).all()}

    order_ids = {
        tasks[l.task_id].production_order_id
        for l in missing_lines
        if l.task_id in tasks and tasks[l.task_id].production_order_id
    }
    if not order_ids:
        return

    order_lines_by_order: dict[int, list[ProductionOrderLine]] = defaultdict(list)
    for ol in db.query(ProductionOrderLine).filter(ProductionOrderLine.order_id.in_(order_ids)).all():
        order_lines_by_order[ol.order_id].append(ol)

    item_ids = {ol.item_id for ols in order_lines_by_order.values() for ol in ols if ol.item_id}
    items = {it.id: it for it in db.query(Item).filter(Item.id.in_(item_ids)).all()} if item_ids else {}

    all_comps = db.query(ItemComponent).all()
    parent_map: dict[int, list[tuple[int, float]]] = defaultdict(list)
    for c in all_comps:
        parent_map[c.component_item_id].append((c.parent_item_id, float(c.qty_per_unit)))

    parts = {p.id: p for p in db.query(Part).filter(Part.id.in_({l.part_id for l in missing_lines})).all()}

    for l in missing_lines:
        t = tasks.get(l.task_id)
        if not t or not t.production_order_id:
            continue
        p = parts.get(l.part_id)

        ols = order_lines_by_order.get(t.production_order_id, [])
        if not ols:
            continue

        curr_items = {p.item_id: 1.0} if p and p.item_id else {}
        matching_ols: dict[int, float] = {}
        for _ in range(6):
            next_items = {}
            for item_id, factor in curr_items.items():
                for ol in ols:
                    if ol.item_id == item_id:
                        matching_ols[ol.id] = matching_ols.get(ol.id, 0.0) + float(ol.quantity) * factor
                for parent_id, per in parent_map.get(item_id, []):
                    next_items[parent_id] = next_items.get(parent_id, 0.0) + factor * per
            curr_items = next_items

        if not matching_ols:
            # Fallback по габаритам и серии/цвету для щитовых дверей (размер ПФ = размер полотна + 10 мм)
            m_pf = re.search(r"(\d{3,4})[хx](\d{3,4})", l.part_name or "")
            if m_pf:
                pf_w, pf_h = int(m_pf.group(1)), int(m_pf.group(2))
                target_dw, target_dh = pf_w - 10, pf_h - 10

                m_ser = re.search(r"\b([А-ЯA-Z]-\d+(?:\.\d+)?)\b", l.part_name or "")
                p_series = m_ser.group(1).split(".")[0] if m_ser else ""

                p_col = ""
                m_c = re.search(r"\((?:ПЭТ|ПВХ|Полипропилен)?\s*([А-Яа-яЁёA-Za-z0-9\s\-]+?)(?:,|\))", l.part_name or "")
                if m_c:
                    val = m_c.group(1).strip().lower()
                    if not any(k in val for k in ["фрезер", "ламин", "заготовк", "мдф", "беларусь", "kastamonu"]):
                        p_col = val

                dim_matches: dict[int, float] = {}
                for ol in ols:
                    oit = items.get(ol.item_id) if ol.item_id else None
                    dc = door_cols([], ol.source_text, oit.name if oit else None)
                    m_d = re.search(r"(\d{3,4})[хx](\d{3,4})", dc.get("size", ""))
                    if m_d:
                        dw, dh = int(m_d.group(1)), int(m_d.group(2))
                        if dw == target_dw and dh == target_dh:
                            ol_base_series = dc.get("series", "").split(".")[0]
                            if p_series and ol_base_series and p_series != ol_base_series:
                                continue
                            if p_col:
                                ol_col = dc.get("color", "").lower()
                                words = [w for w in p_col.split() if len(w) > 3]
                                if words and not any(w in ol_col for w in words) and p_col not in ol_col:
                                    continue
                            dim_matches[ol.id] = float(ol.quantity)
                if dim_matches:
                    matching_ols = dim_matches

        if not matching_ols:
            continue

        total_match = sum(matching_ols.values())
        line_qty = float(l.quantity_pieces)
        scale = line_qty / total_match if total_match > 0 else 1.0

        for ol_id, qty in matching_ols.items():
            result[l.id][ol_id] = round(qty * scale, 2)


def source_allocations(
    db: Session, lines: list[ProductionTaskLine]
) -> dict[int, dict[int, float]]:
    """Возвращает {task_line_id: {order_line_id: quantity}}.

    Для строк до появления таблицы источников использует прямую связь
    order_line_id, если она сохранена, или дерево спецификации заказа.
    """
    line_ids = [line.id for line in lines if line.id is not None]
    records = (
        db.query(ProductionTaskLineSource)
        .filter(ProductionTaskLineSource.task_line_id.in_(line_ids or [-1]))
        .all()
    )
    result: dict[int, dict[int, float]] = defaultdict(dict)
    for record in records:
        result[record.task_line_id][record.order_line_id] = float(record.quantity_pieces)

    for line in lines:
        if not result.get(line.id) and line.order_line_id:
            result[line.id][line.order_line_id] = float(line.quantity_pieces)

    infer_missing_sources(db, lines, result)
    return dict(result)
