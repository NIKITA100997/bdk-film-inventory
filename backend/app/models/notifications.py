"""Персистентная история уведомлений (раздел 16 бэклога доработок) —
колокольчик раньше был живым пересчётом сигнала "давно не двигалось" без
истории и без прочитано/непрочитано. Read/unread — глобальный на
уведомление (read_at/read_by), не per-user join-таблица: в системе
сейчас фактически один активный пользователь, полноценный per-user
read-tracking был бы избыточен и не имеет прецедента в этом кодбейзе (по
образцу DeletionRequest.resolved_at/resolved_by — ближайший существующий
"жизненный цикл"). signal_type — дискриминатор на будущее (другие
сигналы можно подключить без новой миграции), но реально заведён пока
только "stale_unit" — единственный сигнал, подключённый к колокольчику
сегодня (см. services/notifications.py). Без фонового планировщика —
first_seen_at/resolved_at заполняются "сверкой при чтении" в самом
GET /notifications, использующем тот же поллинг, что уже есть у
колокольчика."""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class Notification(Base):
    """Уникальность "одна открытая запись на сигнал" (resolved_at IS NULL)
    не выражается обычным UniqueConstraint (частичный индекс) — её
    обеспечивает сам код сверки (reconcile_stale_unit_notifications ищет
    существующую открытую запись перед вставкой), не БД-уровень; единственный
    писатель — сам эндпоинт при поллинге, конфликт маловероятен."""

    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True)
    signal_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[int]
    title: Mapped[str] = mapped_column(String(255))
    detail: Mapped[str | None] = mapped_column(String(500), nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    read_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
