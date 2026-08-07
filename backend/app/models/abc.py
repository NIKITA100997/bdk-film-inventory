"""ABC-анализ ширин и настройки расчётов (2.9/5.6 ТЗ)."""

import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, Numeric, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class WidthClass(str, enum.Enum):
    A = "A"
    B = "B"
    C = "C"


class WidthAbcClass(Base):
    """Классификация ширины по фактическому расходу за период (2.9 ТЗ).
    Пересчитывается целиком (upsert по паре material+color+thickness+width)
    вызовом /abc/recompute — без встроенного планировщика (см. открытые
    вопросы плана)."""

    __tablename__ = "width_abc_classes"
    __table_args__ = (UniqueConstraint("material_id", "color_id", "thickness_id", "width_mm"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id"), index=True)
    color_id: Mapped[int] = mapped_column(ForeignKey("colors.id"), index=True)
    thickness_id: Mapped[int] = mapped_column(ForeignKey("thicknesses.id"), index=True)
    width_mm: Mapped[float] = mapped_column(Numeric(10, 2))
    width_class: Mapped[WidthClass] = mapped_column(Enum(WidthClass, name="width_class"))
    total_length_m: Mapped[float] = mapped_column(Numeric(12, 3))  # расход за период — справочно
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class CalcSettings(Base):
    """Singleton-строка (id=1) — настройки расчётов (5.6 ТЗ)."""

    __tablename__ = "calc_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    min_useful_width_mm: Mapped[float] = mapped_column(Numeric(10, 2), default=30)
    abc_recalc_period_days: Mapped[int] = mapped_column(Integer, default=90)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
