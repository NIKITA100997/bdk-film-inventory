from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, Numeric, SmallInteger, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

PLAN_DRAFT = "draft"
PLAN_SUBMITTED = "submitted"
PLAN_APPROVED = "approved"
PLAN_CHANGED = "changed"  # утверждён, потом изменён — ждёт повторного утверждения


class ProductionPlan(Base):
    """План недели (12.10): заказы с обещанной готовностью на неделю,
    утверждение руководителем, версии."""

    __tablename__ = "production_plans"

    id: Mapped[int] = mapped_column(primary_key=True)
    week_start: Mapped[date] = mapped_column(Date, unique=True)
    status: Mapped[str] = mapped_column(String(16), default=PLAN_DRAFT, server_default=PLAN_DRAFT)
    version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    submitted_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    comment: Mapped[str | None] = mapped_column(String(500), nullable=True)


class ProductionPlanItem(Base):
    """Снимок состава плана на версию: заказ, даты, приоритет, штук."""

    __tablename__ = "production_plan_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("production_plans.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("production_orders.id", ondelete="SET NULL"), nullable=True)
    order_name: Mapped[str] = mapped_column(String(255))
    priority: Mapped[int] = mapped_column(SmallInteger, default=0, server_default="0")
    promised_ready: Mapped[date | None] = mapped_column(Date, nullable=True)
    ship_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    qty: Mapped[float] = mapped_column(Numeric(12, 2), default=0, server_default="0")


class ProductionPlanEvent(Base):
    """Журнал плана: отправлен, утверждён, возвращён, срочный заказ, перенос."""

    __tablename__ = "production_plan_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("production_plans.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(String(500))
    order_id: Mapped[int | None] = mapped_column(nullable=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
