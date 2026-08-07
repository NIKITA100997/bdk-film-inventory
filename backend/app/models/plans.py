from datetime import date

from sqlalchemy import Date, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class WeeklyPlan(Base):
    __tablename__ = "weekly_plans"

    id: Mapped[int] = mapped_column(primary_key=True)
    week_start: Mapped[date] = mapped_column(Date, index=True)
    week_end: Mapped[date] = mapped_column(Date)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(32), default="draft")  # draft / active / closed

    lines: Mapped[list["FilmRequestLine"]] = relationship(back_populates="weekly_plan", cascade="all, delete-orphan")


class FilmRequestLine(Base):
    """Позиция заявки на плёнку — в м², точные ширины на этом этапе обычно
    ещё не известны, поэтому без производителя и без SKU целиком, только
    материал+цвет+толщина из справочников (2.1a/2.7 ТЗ)."""

    __tablename__ = "film_request_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    weekly_plan_id: Mapped[int] = mapped_column(ForeignKey("weekly_plans.id"))

    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id"))
    color_id: Mapped[int] = mapped_column(ForeignKey("colors.id"))
    thickness_id: Mapped[int] = mapped_column(ForeignKey("thicknesses.id"))

    planned_area_m2: Mapped[float] = mapped_column(Numeric(12, 2))

    weekly_plan: Mapped[WeeklyPlan] = relationship(back_populates="lines")
