import enum

from sqlalchemy import Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class RackType(str, enum.Enum):
    ROLL = "roll"  # рулонный: полка = один рулон
    STRIP = "strip"  # штрипсовый (включая стеллаж Б): полка делится на ячейки


class Rack(Base):
    """Стеллаж (раздел 4/4.1 ТЗ). Полки — не отдельные строки в БД, а просто
    числа 1..shelf_count: адрес единицы ("Р-3-07") — свободная строка,
    состав стеллажа задаётся только числом полок при вводе в эксплуатацию
    (5.6, макет admin_add_rack)."""

    __tablename__ = "racks"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(16), unique=True, index=True)  # "Р-3", "Ш-2"
    type: Mapped[RackType] = mapped_column(Enum(RackType, name="rack_type"))
    shelf_count: Mapped[int] = mapped_column(Integer)

    macro_zone_rules: Mapped[list["MacroZoneRule"]] = relationship(
        back_populates="rack", cascade="all, delete-orphan"
    )


class MacroZoneRule(Base):
    """Правило макрозонирования (4.2 ТЗ) — диапазон полок стеллажа + фильтр
    по справочникам атрибутов (пустое поле = "любое значение"), а не
    текстовое название зоны."""

    __tablename__ = "macro_zone_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    rack_id: Mapped[int] = mapped_column(ForeignKey("racks.id"))
    from_shelf: Mapped[int] = mapped_column(Integer)
    to_shelf: Mapped[int] = mapped_column(Integer)

    material_id: Mapped[int | None] = mapped_column(ForeignKey("materials.id"), nullable=True)
    color_id: Mapped[int | None] = mapped_column(ForeignKey("colors.id"), nullable=True)
    thickness_id: Mapped[int | None] = mapped_column(ForeignKey("thicknesses.id"), nullable=True)
    manufacturer_id: Mapped[int | None] = mapped_column(ForeignKey("manufacturers.id"), nullable=True)

    rack: Mapped[Rack] = relationship(back_populates="macro_zone_rules")
