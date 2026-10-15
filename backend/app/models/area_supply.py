"""Снабжение участков (15.10, этап 3 выдачи плёнки) — одинаково для плёнки,
п/ф и материалов:

- заявка участка («нужен рулон», «закончился клей») — по желанию, там, где
  нет заданий (прессы, ламинация: «закончилась — выдают») или нужно сверх
  них; кладовщик принимает и закрывает;
- неснижаемый остаток участка — сколько должно лежать на участке; ниже —
  участок сам попадает в «пополнить». Считается там, где остаток на
  участке ведётся: плёнка (рулоны «выдан участку», м²) и п/ф (партии на
  участке, шт)."""

from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

REQ_NEW = "new"  # подана
REQ_ACCEPTED = "accepted"  # кладовщик взял в работу
REQ_DONE = "done"  # выдано
REQ_CANCELLED = "cancelled"  # отменена (участком или складом, с причиной)
REQ_OPEN = (REQ_NEW, REQ_ACCEPTED)


class AreaRequest(Base):
    __tablename__ = "area_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    area: Mapped[str] = mapped_column(ForeignKey("areas.code"), index=True)
    # что нужно: позиция номенклатуры (у плёнки — любая позиция группы
    # материал + цвет + толщина, производитель не важен) или свободный текст
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id"), nullable=True, index=True)
    what: Mapped[str | None] = mapped_column(String(255), nullable=True)
    qty: Mapped[float | None] = mapped_column(Numeric(14, 3), nullable=True)
    unit: Mapped[str | None] = mapped_column(String(16), nullable=True)
    width_mm: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)  # плёнка: нужная ширина
    needed_by: Mapped[date | None] = mapped_column(Date, nullable=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=REQ_NEW, server_default=REQ_NEW, index=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    close_note: Mapped[str | None] = mapped_column(String(255), nullable=True)


class AreaStockNorm(Base):
    __tablename__ = "area_stock_norms"
    __table_args__ = (UniqueConstraint("area", "item_id", name="uq_area_stock_norm"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    area: Mapped[str] = mapped_column(ForeignKey("areas.code"), index=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"))
    min_qty: Mapped[float] = mapped_column(Numeric(14, 3))  # плёнка — м², п/ф — шт
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
