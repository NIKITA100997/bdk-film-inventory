import enum

from sqlalchemy import Enum, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class RackType(str, enum.Enum):
    ROLL = "roll"  # рулонный: полка = один рулон
    STRIP = "strip"  # штрипсовый (включая стеллаж Б): полка делится на ячейки


class Rack(Base):
    __tablename__ = "racks"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(16), unique=True, index=True)  # "Р-3", "Ш-2"
    type: Mapped[RackType] = mapped_column(Enum(RackType, name="rack_type"))

    shelves: Mapped[list["Shelf"]] = relationship(back_populates="rack", cascade="all, delete-orphan")


class Shelf(Base):
    __tablename__ = "shelves"

    id: Mapped[int] = mapped_column(primary_key=True)
    rack_id: Mapped[int] = mapped_column(ForeignKey("racks.id"))
    number: Mapped[int]
    macro_zone: Mapped[str | None] = mapped_column(String(255), nullable=True)

    rack: Mapped[Rack] = relationship(back_populates="shelves")
    cells: Mapped[list["Cell"]] = relationship(back_populates="shelf", cascade="all, delete-orphan")


class Cell(Base):
    """Ячейки существуют только на штрипсовых стеллажах (включая Б) — на
    рулонных полка = один рулон, ячейка не нужна (раздел 4 ТЗ)."""

    __tablename__ = "cells"

    id: Mapped[int] = mapped_column(primary_key=True)
    shelf_id: Mapped[int] = mapped_column(ForeignKey("shelves.id"))
    number: Mapped[int]

    shelf: Mapped[Shelf] = relationship(back_populates="cells")
