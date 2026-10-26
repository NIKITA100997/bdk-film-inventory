from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Integer, Numeric, SmallInteger, String, UniqueConstraint, func
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
    # Заявка менеджера (09.10): вилка отгрузки, в которую готов клиент;
    # ship_date — твёрдая дата (100%), её ставит производство при приёме.
    # request_status: submitted — отправлена, returned — возвращена с
    # комментарием, accepted — принята; пусто — обычный черновик.
    ship_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    ship_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    request_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    request_comment: Mapped[str | None] = mapped_column(String(500), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    submitted_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    decided_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Планирование, этап 1 (12.10): клиент и сумма — из счёта; приоритет —
    # от менеджера (0 обычный, 1 высокий, 2 срочный); две обещанные даты:
    # готовность (всё на складе ГП) и отгрузка (ship_date). ready_at —
    # фактическая готовность, поправленная вручную; пусто — по приходу на склад.
    customer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    amount_rub: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    priority: Mapped[int] = mapped_column(SmallInteger, default=0, server_default="0")
    promised_ready: Mapped[date | None] = mapped_column(Date, nullable=True)
    ready_at: Mapped[date | None] = mapped_column(Date, nullable=True)
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
    # исполнение (26.10): [{code, name, value, op}] — из строки заказа клиента / счёта
    options: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Строка заказа клиента (13.10): что из счёта закрывает эта строка запуска.
    customer_order_line_id: Mapped[int | None] = mapped_column(
        ForeignKey("customer_order_lines.id", ondelete="SET NULL"), nullable=True, index=True
    )

    order: Mapped[ProductionOrder] = relationship(back_populates="lines")


class OrderDateChange(Base):
    """Перенос обещанной даты заказа (12.10): что, с какой на какую, почему."""

    __tablename__ = "order_date_changes"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("production_orders.id", ondelete="CASCADE"), nullable=True, index=True)
    # с 13.10 даты обещаются по заказу клиента
    customer_order_id: Mapped[int | None] = mapped_column(ForeignKey("customer_orders.id", ondelete="CASCADE"), nullable=True, index=True)
    field: Mapped[str] = mapped_column(String(16))  # ship — отгрузка, ready — готовность
    old_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    new_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    comment: Mapped[str | None] = mapped_column(String(500), nullable=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ProductionCalendarDay(Base):
    """Исключение из пятидневки (12.10): праздник, рабочая суббота, отключили
    свет. area пусто — для всех участков, иначе — только для этого."""

    __tablename__ = "production_calendar"
    __table_args__ = (UniqueConstraint("day", "area", name="uq_production_calendar_day_area"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    day: Mapped[date] = mapped_column(Date, index=True)
    area: Mapped[str | None] = mapped_column(ForeignKey("areas.code", ondelete="CASCADE"), nullable=True)
    is_workday: Mapped[bool] = mapped_column(Boolean)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
