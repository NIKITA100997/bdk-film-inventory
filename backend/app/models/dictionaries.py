"""Справочники атрибутов (2.1a ТЗ) — материал/цвет/толщина/производитель не
текстовые поля, а ссылки на эти четыре справочника, чтобы "Дуб беленый" и
"Дуб белёный" не расползались на два разных значения. MaterialSku — позиция
материала: конкретная комбинация значений из всех четырёх + данные
поставщика."""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base


class Material(Base):
    __tablename__ = "materials"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Color(Base):
    __tablename__ = "colors"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Thickness(Base):
    __tablename__ = "thicknesses"

    id: Mapped[int] = mapped_column(primary_key=True)
    value_mm: Mapped[float] = mapped_column(Numeric(10, 3), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Manufacturer(Base):
    __tablename__ = "manufacturers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class MaterialSku(Base):
    """Позиция материала (5.6 ТЗ) — конкретная комбинация материал+цвет+
    толщина+производитель, а не текст. `native_width_mm` — родная ширина
    рулона от поставщика, используется автоподбором места (4.2), чтобы
    отличить целый рулон от штрипса."""

    __tablename__ = "material_skus"
    __table_args__ = (UniqueConstraint("material_id", "color_id", "thickness_id", "manufacturer_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id"))
    color_id: Mapped[int] = mapped_column(ForeignKey("colors.id"))
    thickness_id: Mapped[int] = mapped_column(ForeignKey("thicknesses.id"))
    manufacturer_id: Mapped[int] = mapped_column(ForeignKey("manufacturers.id"))
    supplier_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    native_width_mm: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    # Путь фото плёнки на диске сервера (8 раздел обратной связи), относительно
    # UPLOAD_DIR — отдаётся статикой, во внешнем хранилище нужды пока нет.
    photo_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    material: Mapped[Material] = relationship()
    color: Mapped[Color] = relationship()
    thickness: Mapped[Thickness] = relationship()
    manufacturer: Mapped[Manufacturer] = relationship()

    @property
    def display_name(self) -> str:
        return f"{self.material.name}, {self.color.name}, {self.thickness.value_mm} мм, {self.manufacturer.name}"


class SkuAnalog(Base):
    """Ручная привязка аналогов между позициями номенклатуры (8 раздел
    обратной связи) — заводит логист/админ, не автоматика по атрибутам.
    Связь ненаправленная по смыслу (A аналог B ⇒ B аналог A), но хранится
    один раз как направленная пара; читается в обе стороны — см.
    services/analogs.list_analogs_for_sku."""

    __tablename__ = "sku_analogs"
    __table_args__ = (UniqueConstraint("sku_id", "analog_sku_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    sku_id: Mapped[int] = mapped_column(ForeignKey("material_skus.id"))
    analog_sku_id: Mapped[int] = mapped_column(ForeignKey("material_skus.id"))
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    sku: Mapped[MaterialSku] = relationship(foreign_keys=[sku_id])
    analog_sku: Mapped[MaterialSku] = relationship(foreign_keys=[analog_sku_id])
