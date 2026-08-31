"""Перемещение между складами (раздел про хаб на Северном и отправку на
Фабрику) — вся резка происходит на основном складе, но часть плёнки
физически предназначена для второй площадки. WarehouseTransfer — партия
(мини-накладная), WarehouseTransferLine — одна единица в этой партии.
Статус самой единицы (MaterialUnit.status=В_перемещении) — источник
истины на то, что она уже не оборотный остаток склада отправления; связь
с перемещением — только через строку, без обратного FK на MaterialUnit
(тот же приём decoupling, что уже у PurchaseRequest/MaterialUnit —
запрос и физическое движение остатка разведены)."""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base
from app.models.units import MaterialUnit

# Как у PurchaseRequest.status — обычная строка, не Postgres ENUM (проще
# миграция, не нужен ALTER TYPE ради состояния самой партии).
STATUS_SOBIRAETSYA = "sobiraetsya"
STATUS_OTPRAVLENO = "otpravleno"
STATUS_PRINYATO = "prinyato"


class WarehouseTransfer(Base):
    __tablename__ = "warehouse_transfers"

    id: Mapped[int] = mapped_column(primary_key=True)
    from_warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))
    to_warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))
    status: Mapped[str] = mapped_column(String(32), default=STATUS_SOBIRAETSYA)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    shipped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Выставляется, когда приняты ВСЕ строки партии.
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WarehouseTransferLine(Base):
    __tablename__ = "warehouse_transfer_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    transfer_id: Mapped[int] = mapped_column(ForeignKey("warehouse_transfers.id"), index=True)
    unit_id: Mapped[int] = mapped_column(ForeignKey("material_units.id"), index=True)
    unit: Mapped[MaterialUnit] = relationship()
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
