"""Модели универсального аудита изменений (Audit Trail) и очереди недоставленных событий (Dead Letter Queue)."""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class EntityAuditLog(Base):
    """Журнал аудита ключевых изменений в системе (кто, когда, какую сущность изменил и какие поля поменялись)."""

    __tablename__ = "entity_audit_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(64), index=True)  # "CustomerOrder", "ProductionTask", "MaterialUnit", "Price"
    entity_id: Mapped[int] = mapped_column(Integer, index=True)
    action: Mapped[str] = mapped_column(String(32))  # "CREATE", "UPDATE", "DELETE", "STATUS_CHANGE"
    changed_fields: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # {"field": {"old": ..., "new": ...}}
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    user_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class DeadLetterEvent(Base):
    """Очередь недоставленных внешних событий (Bitrix24, вебхуки, фоновые интеграции) с retry-механизмом."""

    __tablename__ = "dead_letter_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    service: Mapped[str] = mapped_column(String(64), index=True)  # "bitrix24", "1c", "notifications"
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    payload: Mapped[dict] = mapped_column(JSON)
    attempts: Mapped[int] = mapped_column(Integer, default=1)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="pending", index=True)  # "pending", "delivered", "dead_letter"
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    last_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
