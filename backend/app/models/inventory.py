"""Инвентаризация и первичное внесение остатков (2.10/6.8 ТЗ) — один и тот
же механизм для обоих случаев: у первичного внесения просто пустой
ожидаемый список."""

import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class InventoryScopeType(str, enum.Enum):
    RACK = "rack"
    WAREHOUSE = "warehouse"
    MATERIAL_SKU = "material_sku"


class InventoryStatus(str, enum.Enum):
    IN_PROGRESS = "in_progress"
    CLOSED = "closed"


class InventorySession(Base):
    __tablename__ = "inventory_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    scope_type: Mapped[InventoryScopeType] = mapped_column(Enum(InventoryScopeType, name="inventory_scope_type"))
    # Ссылка на rack_id или material_sku_id в зависимости от scope_type (пусто
    # для warehouse) — не строгий FK, т.к. таблица зависит от scope_type.
    scope_ref_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[InventoryStatus] = mapped_column(
        Enum(InventoryStatus, name="inventory_status"), default=InventoryStatus.IN_PROGRESS
    )
    started_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    closed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
