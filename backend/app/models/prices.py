"""Цены (05.10): валюты с общим курсом и история цен позиций номенклатуры.

У позиции своя условная единица цены — валюта (рубли, евро, доллары) и
единица («м²» у плёнки, иначе — единица позиции); курс общий на всё
приложение (настройка). Цена приходит из трёх мест: вручную в карточке
позиции, загрузкой из 1С и при приходе по УПД — каждая запись хранится с
источником и датой, действующая цена — последняя на дату."""

from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

PRICE_MANUAL = "manual"
PRICE_1C = "1c"
PRICE_UPD = "upd"
PRICE_SOURCES = {PRICE_MANUAL: "вручную", PRICE_1C: "из 1С", PRICE_UPD: "по УПД"}


class Currency(Base):
    """Валюта и её курс к рублю (сколько рублей за единицу). Рубль — 1."""

    __tablename__ = "currencies"

    code: Mapped[str] = mapped_column(String(3), primary_key=True)  # RUB, EUR, USD
    name: Mapped[str] = mapped_column(String(32))
    symbol: Mapped[str] = mapped_column(String(4))
    # Курс не задан (None) — цены в этой валюте в рубли не пересчитываются,
    # отчёты показывают, сколько позиций без курса.
    rate: Mapped[float | None] = mapped_column(Numeric(14, 4), nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class ItemPrice(Base):
    """Цена позиции с даты: в валюте и за единицу, откуда взялась."""

    __tablename__ = "item_prices"

    id: Mapped[int] = mapped_column(primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"), index=True)
    price: Mapped[float] = mapped_column(Numeric(14, 4))
    currency: Mapped[str] = mapped_column(ForeignKey("currencies.code"))
    unit: Mapped[str] = mapped_column(String(16))  # за что цена: «м²», «м», «шт», «кг»…
    source: Mapped[str] = mapped_column(String(8))
    doc: Mapped[str | None] = mapped_column(String(64), nullable=True)  # номер УПД / файла 1С
    valid_from: Mapped[date] = mapped_column(Date, index=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
