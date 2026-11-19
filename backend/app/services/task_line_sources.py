"""Исходные позиции заказа, вошедшие в строки заданий участков."""

from collections import defaultdict

from sqlalchemy.orm import Session

from app.models.dictionaries import Part
from app.models.items import ItemComponent
from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineSource
from app.models.production_orders import ProductionOrderLine


def infer_missing_sources(
    db: Session,
    lines: list[ProductionTaskLine],
    result: dict[int, dict[int, float]],
) -> None:
    """Для строк без записей в production_task_line_sources (созданных до внедрения таблицы
    или при ручном/старом объединении) восстанавливает связь с order_line_id
    через дерево компонентов ItemComponent заказа.
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
        if not p or not p.item_id:
            continue

        ols = order_lines_by_order.get(t.production_order_id, [])
        if not ols:
            continue

        curr_items = {p.item_id: 1.0}
        matching_ols: dict[int, float] = {}
        for _ in range(3):
            next_items = {}
            for item_id, factor in curr_items.items():
                for ol in ols:
                    if ol.item_id == item_id:
                        matching_ols[ol.id] = matching_ols.get(ol.id, 0.0) + float(ol.quantity) * factor
                for parent_id, per in parent_map.get(item_id, []):
                    next_items[parent_id] = next_items.get(parent_id, 0.0) + factor * per
            curr_items = next_items

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
