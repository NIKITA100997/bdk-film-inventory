"""Заявки на удаление (раздел про удаление сущностей администратором) —
суперпользователь удаляет сразу, остальные сотрудники с правом на
конкретный раздел вместо этого создают заявку, которую рассматривает
администратор (см. api/deletion_requests.py, services/deletion_requests.py).
entity_type/entity_id — не полиморфный FK (разные сущности живут в
разных таблицах), entity_label — снимок "что это было" на момент
запроса, чтобы в очереди на рассмотрение было видно даже то, что уже
исчезло или изменилось."""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class DeletionRequest(Base):
    __tablename__ = "deletion_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[int]
    entity_label: Mapped[str] = mapped_column(String(255))
    reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending / approved / rejected
    requested_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolution_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
