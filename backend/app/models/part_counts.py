"""Пересчёт п/ф на участке (06.10, единые окна операций — инвентаризация).

П/ф хранятся на участках, без бирок и ячеек: инвентаризация — не скан бирок
(как у плёнки, models/inventory.py), а пересчёт участка. Охват — участок и
по желанию группы номенклатуры и стадия; лист — партии, сгруппированные по
детали, у каждой «по учёту» и «факт». Найденное сверх листа — строка без
партии (при решении заводится новая партия). Расхождения не применяются
сами: после закрытия по каждой строке решение — списать / оприходовать /
оставить как есть, тем же журналом партий."""
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base

COUNT_IN_PROGRESS = "in_progress"
COUNT_CLOSED = "closed"

# решения по строке после закрытия
DECISION_WRITE_OFF = "write_off"  # недостача — списать
DECISION_ACCEPT = "accept"  # излишек — оприходовать (добавить к партии / новая партия)
DECISION_KEEP = "keep"  # оставить учёт как есть


class PartCountSession(Base):
    __tablename__ = "part_count_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    area: Mapped[str] = mapped_column(ForeignKey("areas.code"), index=True)
    # охват внутри участка: {"group_ids": [...], "stages": [...]} — пусто = всё
    scope: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=COUNT_IN_PROGRESS)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    started_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PartCountLine(Base):
    __tablename__ = "part_count_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("part_count_sessions.id", ondelete="CASCADE"), index=True)
    # партия из листа; NULL — найдено сверх листа (новая партия при решении)
    part_unit_id: Mapped[int | None] = mapped_column(ForeignKey("part_units.id"), nullable=True)
    part_id: Mapped[int] = mapped_column(ForeignKey("parts.id"))
    stage_id: Mapped[int] = mapped_column(ForeignKey("part_stages.id"))
    # по учёту — свободное количество партии; обновляется в момент ввода факта
    # (между открытием и пересчётом участок мог отчитаться — сравниваем с тем,
    # что числилось, когда считали)
    expected_qty: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    counted_qty: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    counted_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    counted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    decision: Mapped[str | None] = mapped_column(String(16), nullable=True)
    reason: Mapped[str | None] = mapped_column(ForeignKey("write_off_reasons.code"), nullable=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    resolved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # партия, в которую ушёл излишек «сверх листа»
    result_part_unit_id: Mapped[int | None] = mapped_column(ForeignKey("part_units.id"), nullable=True)
