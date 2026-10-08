"""Склад готовой продукции и отгрузка (06.10).

Приход — сам, из отчёта последней операции изделия (упаковки) по строке
заказа: упаковали N — N на складе площадки участка, под этот заказ и счёт.
Остаток — сумма движений (как у материалов, MaterialMove), без партий и
ячеек: по позиции, площадке и строке заказа. Отгрузка — по счёту 1С
(частичная — можно), отменяется целиком: двери возвращаются на склад.
Отгрузочные документы — в 1С, здесь отметка и печатный лист отгрузки."""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base

FG_RECEIPT = "receipt"  # упаковано — на склад
FG_SHIPMENT = "shipment"  # отгружено
FG_UNSHIP = "unship"  # отгрузка отменена — вернулось на склад
FG_ADJUST = "adjust"  # корректировка (пересчёт, оприходование упакованного раньше)
FG_TRANSFER = "transfer"  # перемещение между площадками: − на одной, + на другой
FG_RETURN = "return"  # возврат от клиента по отгрузке — снова на склад

SHIP_DONE = "shipped"
SHIP_CANCELLED = "cancelled"


class FgShipment(Base):
    __tablename__ = "fg_shipments"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_no: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    site_id: Mapped[int | None] = mapped_column(ForeignKey("sites.id"), nullable=True)
    customer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=SHIP_DONE)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    cancelled_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class FgMove(Base):
    __tablename__ = "fg_moves"

    id: Mapped[int] = mapped_column(primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"), index=True)
    qty: Mapped[float] = mapped_column(Numeric(12, 2))  # со знаком: приход +, отгрузка −
    kind: Mapped[str] = mapped_column(String(16))
    site_id: Mapped[int | None] = mapped_column(ForeignKey("sites.id"), nullable=True, index=True)
    order_line_id: Mapped[int | None] = mapped_column(
        ForeignKey("production_order_lines.id", ondelete="SET NULL"), nullable=True, index=True
    )
    invoice_no: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    shipment_id: Mapped[int | None] = mapped_column(ForeignKey("fg_shipments.id"), nullable=True, index=True)
    report_id: Mapped[int | None] = mapped_column(
        ForeignKey("production_task_line_reports.id", ondelete="SET NULL"), nullable=True
    )
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Сумма движения по себестоимости, ₽ (08.10, services/lot_cost.py):
    # приход — по себестоимости штуки строки заказа (отчёты по операциям),
    # остальное — по средней себестоимости остатка позиции.
    amount_rub: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
