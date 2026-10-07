from datetime import date, datetime

from sqlalchemy import JSON, Date, DateTime, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

ORDER_DRAFT = "draft"
ORDER_RELEASED = "released"
ORDER_CLOSED = "closed"
# Вид заказа: клиенту (срок — отгрузка) или на склад — пополнение остатка
# без клиента (срок — «готово к»), продажникам в «Готовности» не показывается.
ORDER_KIND_CUSTOMER = "customer"
ORDER_KIND_STOCK = "stock"


class OrderCategory(Base):
    """Категория заказа на производство — для аналитики (справочник,
    заполняется пользователями; 02.10 заведён пустым)."""

    __tablename__ = "order_categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    is_active: Mapped[bool] = mapped_column(default=True, server_default="true")


class ProductionOrder(Base):
    """Заказ на производство (единая модель, пункт 4) — что и сколько
    сделать: позиции номенклатуры любого вида. Запуск раскладывает его по
    маршрутам позиций на задания участкам («Задания цеха», по одному на
    участок); комплектующие п/ф обеспечиваются через «Потребность п/ф»
    (заказ × состав), а расходуются отчётом той операции, на которой по
    составу нужны. Щитовые, царговые, металлические двери — один и тот же
    заказ, разница только в техкарте позиции."""

    __tablename__ = "production_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    ship_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=ORDER_DRAFT)
    kind: Mapped[str] = mapped_column(String(16), default=ORDER_KIND_CUSTOMER, server_default=ORDER_KIND_CUSTOMER)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("order_categories.id"), nullable=True)
    # Настройки запуска черновика (05.10): п/ф (со склада / в работу),
    # площадки ламинации, ручные правки строк, сроки — сохраняются по ходу
    # настройки, чтобы вернуться к запуску позже. Формат — у экрана запуска.
    release_settings: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    lines: Mapped[list["ProductionOrderLine"]] = relationship(
        back_populates="order", order_by="ProductionOrderLine.sort_order", cascade="all, delete-orphan"
    )


class ProductionOrderLine(Base):
    __tablename__ = "production_order_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("production_orders.id", ondelete="CASCADE"), index=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"))
    quantity: Mapped[float] = mapped_column(Numeric(12, 2))
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Счёт / заказ 1С (02.10): в одном запуске — двери разных счетов; по
    # счетам продажники смотрят готовность.
    invoice_no: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # Исходная строка графика (07.10): подверсия серии и молдинг для подбора
    # программы фрезеровки — в позиции двери их нет.
    source_text: Mapped[str | None] = mapped_column(String(500), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    order: Mapped[ProductionOrder] = relationship(back_populates="lines")
