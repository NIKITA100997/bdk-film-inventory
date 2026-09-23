from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class AreaTask(Base):
    """Задание участку (раздел про задания участкам) — работа для любого
    участка без плёнки: у каждого участка свой экран заданий. «Задания цеха»
    (ProductionTask) остаются для плёнки и не меняются.

    source — откуда взялось: "manual" (завёл начальник) или "shield_batch"
    (родилось из запуска щитовых дверей)."""

    __tablename__ = "area_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    area: Mapped[str] = mapped_column(ForeignKey("areas.code"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    source: Mapped[str] = mapped_column(String(32), default="manual")
    ship_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    lines: Mapped[list["AreaTaskLine"]] = relationship(
        back_populates="task", order_by="AreaTaskLine.sort_order", cascade="all, delete-orphan"
    )


class AreaTaskLine(Base):
    """Строка задания участку. part_stage_id — необязательная привязка к этапу
    детали п/ф: тогда отчёт двигает партии этой детали (первый этап детали —
    рождает партию, средний — переводит дальше). Этап задаётся явно, а не
    выводится из участка: у одной детали на одном участке бывает несколько
    этапов подряд (Склейка МДФ и Фрезеровка коробки)."""

    __tablename__ = "area_task_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("area_tasks.id", ondelete="CASCADE"), index=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(String(255))
    quantity_pieces: Mapped[float] = mapped_column(Numeric(12, 2))
    part_stage_id: Mapped[int | None] = mapped_column(ForeignKey("part_stages.id"), nullable=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)

    task: Mapped[AreaTask] = relationship(back_populates="lines")
    reports: Mapped[list["AreaTaskReport"]] = relationship(
        back_populates="line", order_by="AreaTaskReport.occurred_at", cascade="all, delete-orphan"
    )


class AreaTaskReport(Base):
    """Отчёт по строке задания участку — накопительный журнал (план строки не
    мутируется), как у заданий с плёнкой."""

    __tablename__ = "area_task_reports"

    id: Mapped[int] = mapped_column(primary_key=True)
    line_id: Mapped[int] = mapped_column(ForeignKey("area_task_lines.id", ondelete="CASCADE"), index=True)
    good_pieces: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    defect_pieces: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    defect_reason: Mapped[str | None] = mapped_column(ForeignKey("write_off_reasons.code"), nullable=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    reported_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    line: Mapped[AreaTaskLine] = relationship(back_populates="reports")
