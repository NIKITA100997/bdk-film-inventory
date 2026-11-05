"""Исходные позиции заказа, вошедшие в строки заданий участков."""

from collections import defaultdict

from sqlalchemy.orm import Session

from app.models.production import ProductionTaskLine, ProductionTaskLineSource


def source_allocations(
    db: Session, lines: list[ProductionTaskLine]
) -> dict[int, dict[int, float]]:
    """Возвращает {task_line_id: {order_line_id: quantity}}.

    Для строк до появления таблицы источников использует прямую связь
    order_line_id, если она сохранена.
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
    return dict(result)
