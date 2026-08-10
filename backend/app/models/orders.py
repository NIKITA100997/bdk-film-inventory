from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base


class Order(Base):
    """Заказ — единица планирования (4 раздел обратной связи, заменяет
    собой недельный план): у заказа есть свои строки потребности в
    материале (`lines`), план/факт считается по нему самому, а не по
    календарной неделе — факт тянется из MaterialEvent.order_id, который
    уже проставлялся при выдаче/резке и раньше, просто не использовался
    для план/факта."""

    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(32), default="open")  # open / closed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    lines: Mapped[list["OrderMaterialLine"]] = relationship(back_populates="order", cascade="all, delete-orphan")


class OrderMaterialLine(Base):
    """Строка потребности заказа в материале — в м², без производителя
    (как и было у заявки на плёнку, 2.7 ТЗ: точные ширины на этом этапе
    обычно ещё не известны)."""

    __tablename__ = "order_material_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"))

    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id"))
    color_id: Mapped[int] = mapped_column(ForeignKey("colors.id"))
    thickness_id: Mapped[int] = mapped_column(ForeignKey("thicknesses.id"))

    planned_area_m2: Mapped[float] = mapped_column(Numeric(12, 2))

    order: Mapped[Order] = relationship(back_populates="lines")
