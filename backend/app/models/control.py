"""Закрытие периода и запросы администратору (07.10.2026).

PeriodClosing — журнал закрытий и открытий: действующая граница — последняя
запись (closed_until; пусто — ничего не закрыто). Записи с датой не позже
границы (события рулонов и партий, движения готовой продукции, отчёты,
цены) не создаются, не правятся и не удаляются — services/period_guard.py.

ActionRequest — «попросить администратора»: сотруднику отказали (нет прав
или период закрыт) — запрос хранит само действие (метод, путь, тело).
Администратор выполняет его от своего имени (с пометкой, по чьей просьбе)
или отклоняет с причиной."""

from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base

PERIOD_CLOSE = "close"
PERIOD_REOPEN = "reopen"

REQ_PENDING = "pending"
REQ_EXECUTING = "executing"
REQ_DONE = "done"
REQ_FAILED = "failed"
REQ_REJECTED = "rejected"


class PeriodClosing(Base):
    __tablename__ = "period_closings"

    id: Mapped[int] = mapped_column(primary_key=True)
    closed_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    action: Mapped[str] = mapped_column(String(8))
    reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ActionRequest(Base):
    __tablename__ = "action_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    method: Mapped[str] = mapped_column(String(8))
    path: Mapped[str] = mapped_column(String(500))
    body: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON как пришёл
    summary: Mapped[str] = mapped_column(String(500))  # что за действие, по-русски
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)  # почему отказали
    kind: Mapped[str] = mapped_column(String(16))  # forbidden / period_closed
    page: Mapped[str | None] = mapped_column(String(255), nullable=True)  # где нажали
    comment: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(16), default=REQ_PENDING, index=True)
    requested_by: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # сотрудник видел решение (для счётчика в шапке)
    seen: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
