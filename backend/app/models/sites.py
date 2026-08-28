"""Площадка (раздел про площадки) — реальных физических площадок у компании
две (Северный, Фабрика), у каждой свой домашний склад. Площадка группирует
несколько участков (Area.site_id) и жёстко привязана к ровно одному складу
(в отличие от Warehouse, который сам по себе просто тег у стеллажа) — это
даёт возможность подсказать/предупредить при выдаче плёнки участку, если
она физически лежит не на домашнем складе его площадки."""

from sqlalchemy import Boolean, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Site(Base):
    __tablename__ = "sites"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
