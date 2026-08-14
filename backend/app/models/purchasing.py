"""Закупки (5.5/6.1 ТЗ) — заявка снабженцу/закупщику на недостающий
материал. Привязана к группе материал+цвет+толщина (той же, что и строка
недельной заявки на плёнку — производитель на этом этапе ещё не выбран).
Закрывается вручную либо автоматически при ближайшей приёмке этой же
группы материала (см. services/purchasing.py)."""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class Supplier(Base):
    """Поставщик (раздел про историю цен и сроков) — отдельная от
    Manufacturer сущность: производитель плёнки — кто её сделал, поставщик —
    у кого её закупает снабженец. Одна и та же плёнка может приходить от
    разных поставщиков по разной цене/срокам."""

    __tablename__ = "suppliers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    contact: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True)


class PurchaseRequest(Base):
    __tablename__ = "purchase_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id"))
    color_id: Mapped[int] = mapped_column(ForeignKey("colors.id"))
    thickness_id: Mapped[int] = mapped_column(ForeignKey("thicknesses.id"))
    requested_area_m2: Mapped[float] = mapped_column(Numeric(12, 2))
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="open")  # open / closed
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # История цен и сроков поставщика — оба необязательны: заявка может быть
    # создана раньше, чем согласована цена/выбран поставщик. Срок поставки
    # отдельным полем не хранится — считается как closed_at - created_at,
    # эти поля уже есть.
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"), nullable=True)
    price_per_m2: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    # "planner" — обычная заявка снабженца (создание вручную на этом
    # экране); "shop_floor" — создана кнопкой на "Выдаче участку" по
    # нехватке остатка под конкретную строку задания (раздел про замену
    # "Заказов покупателей" — нехватка теперь обнаруживается в моменте
    # выдачи, не на отдельном экране планирования).
    origin: Mapped[str] = mapped_column(String(32), default="planner")
    # Проставляется при приёмке, если получатель явно связал эту заявку с
    # конкретной поставкой по УПД (раздел про ускорение приёмки) — вместо
    # только группового auto_close_on_receipt (services/purchasing.py).
    linked_upd_number: Mapped[str | None] = mapped_column(String(64), nullable=True)
