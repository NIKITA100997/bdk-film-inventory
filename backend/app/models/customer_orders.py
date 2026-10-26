from datetime import date, datetime

from sqlalchemy import JSON, Date, DateTime, ForeignKey, Integer, Numeric, SmallInteger, String, event, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

# Статус заявки — ведётся вручную; «в производстве / готов / отгружен»
# считаются по запускам и складу ГП (services/customer_orders.py).
CO_DRAFT = "draft"
CO_SUBMITTED = "submitted"
CO_RETURNED = "returned"
CO_ACCEPTED = "accepted"
CO_CANCELLED = "cancelled"


class CustomerOrder(Base):
    """Заказ клиента = один счёт 1С (13.10). Менеджер заводит, отправляет в
    производство; производство принимает с обещанными датами и собирает
    принятые заказы в заказ на производство (запуск)."""

    __tablename__ = "customer_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_no: Mapped[str] = mapped_column(String(64), unique=True)
    # ключ счёта (20.10, invoice_1c.invoice_key): «1029-ЛД(М)» = «№1029-лд» —
    # один заказ; ставится сам при записи номера
    invoice_key: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True, index=True)
    invoice_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    customer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    manager_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    amount_rub: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    priority: Mapped[int] = mapped_column(SmallInteger, default=0, server_default="0")
    ship_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    ship_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    promised_ready: Mapped[date | None] = mapped_column(Date, nullable=True)
    ship_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    ready_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=CO_DRAFT, server_default=CO_DRAFT)
    request_comment: Mapped[str | None] = mapped_column(String(500), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    submitted_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    decided_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # сделка Битрикс24 (14.10): привязана к найденной по счёту или создана программой
    bitrix_deal_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    bitrix_stage_sent: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    lines: Mapped[list["CustomerOrderLine"]] = relationship(
        back_populates="order", order_by="CustomerOrderLine.sort_order", cascade="all, delete-orphan"
    )

    @property
    def name(self) -> str:
        """Подпись для сообщений и журналов: «счёт 1726-ВД · клиент»."""
        return f"счёт {self.invoice_no}" + (f" · {self.customer}" if self.customer else "")


class CustomerOrderLine(Base):
    __tablename__ = "customer_order_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("customer_orders.id", ondelete="CASCADE"), index=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"))
    quantity: Mapped[float] = mapped_column(Numeric(12, 2))
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_text: Mapped[str | None] = mapped_column(String(500), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # исполнение (26.10): [{code, name, value, op}] — цвет кромки, тип стекла, уплотнитель…
    options: Mapped[list | None] = mapped_column(JSON, nullable=True)

    order: Mapped[CustomerOrder] = relationship(back_populates="lines")


@event.listens_for(CustomerOrder, "before_insert")
@event.listens_for(CustomerOrder, "before_update")
def _set_invoice_key(_mapper, _conn, co: CustomerOrder) -> None:
    from app.services.invoice_1c import invoice_key

    co.invoice_key = invoice_key(co.invoice_no) or None


class CustomerOrderDeal(Base):
    """Сделки Битрикса заказа клиента (20.10): в Битриксе на один счёт —
    сделка на вид продукции («пог. 3220 шт», «щиты», «царга»). direction —
    вид (trim / shield / tsarg / panel), пусто — сделка на весь заказ.
    Каждая сделка идёт по стадиям за готовностью своих строк."""

    __tablename__ = "customer_order_deals"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("customer_orders.id", ondelete="CASCADE"), index=True)
    deal_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    direction: Mapped[str | None] = mapped_column(String(16), nullable=True)
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    stage_sent: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
