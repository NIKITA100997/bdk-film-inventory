"""Склад готовой продукции (models/finished_goods.py): приход от упаковки,
остатки по позиции × площадке × строке заказа, отгрузка по счёту."""
from dataclasses import dataclass

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.dictionaries import PartStage
from app.models.finished_goods import FG_RECEIPT, FgMove
from app.models.production import ProductionTaskLine, ProductionTaskLineReport
from app.models.production_orders import ProductionOrderLine


def is_last_item_operation(db: Session, stage: PartStage) -> bool:
    """Последняя операция маршрута изделия (у детали п/ф — нет: у неё партии)."""
    if stage.part_id is not None:
        return False
    later = (
        db.query(PartStage.id)
        .filter(PartStage.item_id == stage.item_id, PartStage.sequence_order > stage.sequence_order)
        .first()
    )
    return later is None


def receive_from_report(db: Session, *, line: ProductionTaskLine, stage: PartStage, report: ProductionTaskLineReport, user_id: int) -> FgMove | None:
    """Упаковали — на склад готовой: отчёт последней операции изделия по
    строке заказа (только годные, только засчитываемые в строку)."""
    if not report.counts_toward_line or float(report.good_pieces) <= 0 or line.order_line_id is None:
        return None
    if not is_last_item_operation(db, stage):
        return None
    ol = db.get(ProductionOrderLine, line.order_line_id)
    if ol is None:
        return None
    area = db.get(Area, line.task.area)
    move = FgMove(
        item_id=ol.item_id, qty=float(report.good_pieces), kind=FG_RECEIPT, site_id=area.site_id if area else None,
        order_line_id=ol.id, invoice_no=ol.invoice_no, report_id=report.id, user_id=user_id,
        note=f"Упаковано: {line.task.name or f'задание №{line.task_id}'}",
    )
    db.add(move)
    return move


@dataclass
class Balance:
    item_id: int
    site_id: int | None
    order_line_id: int | None
    qty: float


def balances(db: Session, *, item_ids: list[int] | None = None, order_line_ids: list[int] | None = None) -> list[Balance]:
    q = db.query(FgMove.item_id, FgMove.site_id, FgMove.order_line_id, func.sum(FgMove.qty)).group_by(
        FgMove.item_id, FgMove.site_id, FgMove.order_line_id
    )
    if item_ids is not None:
        q = q.filter(FgMove.item_id.in_(item_ids))
    if order_line_ids is not None:
        q = q.filter(FgMove.order_line_id.in_(order_line_ids))
    return [Balance(i, s, o, round(float(n), 2)) for i, s, o, n in q if abs(float(n)) > 1e-9]


def totals_by_order_line(db: Session, order_line_ids: list[int]) -> dict[int, dict[str, float]]:
    """По строке заказа: упаковано (приход), отгружено, на складе."""
    out: dict[int, dict[str, float]] = {}
    if not order_line_ids:
        return out
    for ol, kind, n in (
        db.query(FgMove.order_line_id, FgMove.kind, func.sum(FgMove.qty))
        .filter(FgMove.order_line_id.in_(order_line_ids))
        .group_by(FgMove.order_line_id, FgMove.kind)
    ):
        t = out.setdefault(ol, {"received": 0.0, "shipped": 0.0, "on_stock": 0.0})
        n = float(n)
        if kind == FG_RECEIPT:
            t["received"] += n
        elif kind in ("shipment", "unship"):
            t["shipped"] -= n
        t["on_stock"] += n
    for t in out.values():
        for k in t:
            t[k] = round(t[k], 2)
    return out
