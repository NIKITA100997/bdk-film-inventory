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
    INVENTARIZATSIYA_PODTVERZHDENO = "Инвентаризация_подтверждено"
    INVENTARIZATSIYA_PEREMESHCHENO = "Инвентаризация_перемещено"
    INVENTARIZATSIYA_IZLISHEK = "Инвентаризация_излишек"
    INVENTARIZATSIYA_NEDOSTACHA = "Инвентаризация_недостача"
    DONOR_PREDLOZHEN = "Донор_предложен"


class MaterialEvent(Base):
    """Журнал движений (раздел 2.6 ТЗ) — источник данных для карточки
    материала и план/факт. Пишется автоматически сервисным слоем, а не
    руками из роутеров, при каждой операции над MaterialUnit."""

    __tablename__ = "material_events"

    event_id: Mapped[int] = mapped_column(primary_key=True)
    unit_id: Mapped[int] = mapped_column(ForeignKey("material_units.id"), index=True)

    # Ссылка на позицию материала (2.1a ТЗ) — для группировки в карточке
    # материала без пересчёта текстовых значений; SKU неизменяем, поэтому
    # денормализация текстом (как раньше material_key) больше не нужна.
    material_sku_id: Mapped[int] = mapped_column(ForeignKey("material_skus.id"), index=True)

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

    # Не из ТЗ буквально, но необходимо для отчёта по расхождениям на
    # сессию (6.8 п.4) — без этого нельзя посчитать итоги конкретной сессии.
    inventory_session_id: Mapped[int | None] = mapped_column(ForeignKey("inventory_sessions.id"), nullable=True)

    # Знак: положительный для приходов, отрицательный для списаний/выдач.
    quantity_delta_m: Mapped[float] = mapped_column(Numeric(12, 3))
