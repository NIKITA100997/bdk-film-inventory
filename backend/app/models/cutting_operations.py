"""Журнал операций резки (раздел про отмену резки и историю в «Заготовках») —
раньше execute_cutting_recipe оставлял только разрозненные MaterialEvent на
доноре и на каждом получившемся куске, без общего идентификатора, который
связывал бы их как «один вызов резки». Из-за этого нельзя было надёжно
показать «что нарезано за одно действие» и тем более отменить его —
группировка по донору+времени ловит совпадения и обходит бэкдейтинг
(occurred_at). CuttingOperation — единственная запись-заголовок на один вызов
/units/cutting-recipe; MaterialEvent.cutting_operation_id и
MaterialUnit.created_by_cutting_operation_id (см. миграцию) — теги
прослеживаемости к ней, не владеющая связь (тот же приём decoupling, что уже
у WarehouseTransferLine/MaterialUnit)."""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class CuttingOperation(Base):
    __tablename__ = "cutting_operations"

    id: Mapped[int] = mapped_column(primary_key=True)

    donor_unit_id: Mapped[int] = mapped_column(ForeignKey("material_units.id"), index=True)
    donor_material_sku_id: Mapped[int] = mapped_column(ForeignKey("material_skus.id"), index=True)

    # Снимок донора до резки — нужен для точного отката (не для отображения:
    # текущее состояние донора может к моменту отмены уже быть другим по
    # совсем не связанной причине, поэтому именно снимок, а не пересчёт).
    donor_width_before_mm: Mapped[float] = mapped_column(Numeric(10, 2))
    donor_length_before_m: Mapped[float] = mapped_column(Numeric(12, 3))
    donor_status_before: Mapped[str] = mapped_column(String(32))
    donor_location_code_before: Mapped[str | None] = mapped_column(String(32), nullable=True)

    donor_width_after_mm: Mapped[float] = mapped_column(Numeric(10, 2))
    donor_length_after_m: Mapped[float] = mapped_column(Numeric(12, 3))
    donor_status_after: Mapped[str] = mapped_column(String(32))
    donor_auto_written_off: Mapped[bool] = mapped_column(Boolean, default=False)

    length_precut_m: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)

    # Права, фактически потребовавшиеся на эту резку (через запятую, тот же
    # набор кодов, что _cutting_recipe_required_permissions вернула бы для
    # исходного payload) — снимок на момент выполнения, а не реконструкция
    # задним числом по событиям (какой кусок donor'а — от длины или от
    # ширины — событиями уже не отличить). Отмена требует того же набора.
    required_permissions: Mapped[str] = mapped_column(String(255))

    # Бизнес-дата операции (может быть задним числом — раздел про дату
    # операции задним числом, occurred_at в CuttingRecipeRequest).
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # Реальное время вставки строки — база для окна отмены (2 часа), не
    # occurred_at: иначе бэкдейченная запись была бы либо сразу
    # «просрочена», либо окно можно было бы обойти, проставив дату вперёд.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))

    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    undone_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
