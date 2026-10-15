"""Резерв плёнки под заказ (15.10): метры на конкретном рулоне/штрипсе
склада, закреплённые за строкой задания (после запуска) или за заказом
клиента (кнопка у срочного заказа, до запуска). Пока резерв активен, эти
метры не выдают и не режут под другой заказ; снять или перехватить —
только с правом «Перехват резерва плёнки» (начальник цеха)."""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

RES_ACTIVE = "active"  # держит метры на складе
RES_USED = "used"  # выдано / разрезано под этот заказ
RES_RELEASED = "released"  # снят: отмена, закрытие, вручную
RES_TAKEN = "taken"  # перехвачен под другой заказ


class FilmReservation(Base):
    __tablename__ = "film_reservations"

    id: Mapped[int] = mapped_column(primary_key=True)
    unit_id: Mapped[int] = mapped_column(ForeignKey("material_units.id", ondelete="CASCADE"), index=True)
    length_m: Mapped[float] = mapped_column(Numeric(12, 3))  # метров на этом рулоне
    area_m2: Mapped[float] = mapped_column(Numeric(12, 3))  # м² штрипса под заказ (без обрези рулона)
    task_line_id: Mapped[int | None] = mapped_column(ForeignKey("production_task_lines.id", ondelete="SET NULL"), nullable=True, index=True)
    customer_order_id: Mapped[int | None] = mapped_column(ForeignKey("customer_orders.id", ondelete="SET NULL"), nullable=True, index=True)
    strip_width_mm: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=RES_ACTIVE, server_default=RES_ACTIVE, index=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
