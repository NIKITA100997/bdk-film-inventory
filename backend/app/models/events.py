import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base
from app.models.users import Area


class EventType(str, enum.Enum):
    PRIHOD = "Приход"
    PRODOLNAYA_REZKA = "Продольная_резка"
    RASKROY = "Раскрой"
    VYDACHA_UCHASTKU = "Выдача_участку"
    VOZVRAT = "Возврат"
    SPISANIE = "Списание"
    PRIVYAZKA_K_ZAKAZU = "Привязка_к_заказу"
    SNYATIE_PRIVYAZKI = "Снятие_привязки"


class MaterialEvent(Base):
    """Журнал движений (раздел 2.6 ТЗ) — источник данных для карточки
    материала и план/факт. Пишется автоматически сервисным слоем, а не
    руками из роутеров, при каждой операции над MaterialUnit."""

    __tablename__ = "material_events"

    event_id: Mapped[int] = mapped_column(primary_key=True)
    unit_id: Mapped[int] = mapped_column(ForeignKey("material_units.id"), index=True)

    # материал+цвет+толщина+производитель — денормализовано на момент события
    # для группировки в карточке материала без join на material_units.
    material_key: Mapped[str] = mapped_column(String(600), index=True)

    event_type: Mapped[EventType] = mapped_column(Enum(EventType, name="event_type"))
    area: Mapped[Area | None] = mapped_column(Enum(Area, name="area", create_type=False), nullable=True)

    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))

    width_mm: Mapped[float] = mapped_column(Numeric(10, 2))
    from_length: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)
    to_length: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)

    from_cell: Mapped[str | None] = mapped_column(String(32), nullable=True)
    to_cell: Mapped[str | None] = mapped_column(String(32), nullable=True)

    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True)

    # Знак: положительный для приходов, отрицательный для списаний/выдач.
    quantity_delta_m: Mapped[float] = mapped_column(Numeric(12, 3))


def build_material_key(material: str, color: str, thickness: float, manufacturer: str) -> str:
    return f"{material}|{color}|{thickness}|{manufacturer}"
