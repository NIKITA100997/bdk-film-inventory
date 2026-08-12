import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base
from app.models.dictionaries import MaterialSku
from app.models.users import Area


class UnitStatus(str, enum.Enum):
    PRINYAT = "Принят"
    NA_KHRANENII = "На_хранении"
    VYDAN_UCHASTKU = "Выдан_участку"
    SPISAN = "Списан"


class MaterialUnit(Base):
    """Единица учёта плёнки: целый рулон, штрипс или отрезок (раздел 2.1 ТЗ).

    Ширина/длина/адрес всегда актуальны и обновляются при каждом разделении —
    на этикетке не печатаются, смотрим их только здесь (раздел 4.1)."""

    __tablename__ = "material_units"

    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("material_units.id"), nullable=True)

    upd_number: Mapped[str] = mapped_column(String(64), index=True)
    pallet_number: Mapped[str] = mapped_column(String(64))

    material_sku_id: Mapped[int] = mapped_column(ForeignKey("material_skus.id"), index=True)
    material_sku: Mapped[MaterialSku] = relationship()

    width_mm: Mapped[float] = mapped_column(Numeric(10, 2))
    length_m: Mapped[float] = mapped_column(Numeric(12, 3))

    status: Mapped[UnitStatus] = mapped_column(Enum(UnitStatus, name="unit_status"))
    area: Mapped[Area | None] = mapped_column(Enum(Area, name="area", create_type=False), nullable=True)

    # Полный адрес ячейки, пока единица физически на складе: "Р-3-07" или
    # "Ш-2-04-06" (раздел 4.1). Пусто, если выдана участку или ещё не размещена.
    location_code: Mapped[str | None] = mapped_column(String(32), nullable=True)

    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True)
    # Раздел про производственные задания — какую строку задания закрывает
    # выдача этой единицы (тег для прослеживаемости, копируется в
    # MaterialEvent при выдаче — см. services/events.py::record_event).
    production_task_line_id: Mapped[int | None] = mapped_column(
        ForeignKey("production_task_lines.id"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    parent: Mapped["MaterialUnit | None"] = relationship(remote_side=[id])

    @property
    def area_m2(self) -> float:
        """Вычисляемое поле, не хранится (раздел 2.1/2.2 ТЗ) — используется
        только в агрегированной отчётности, не в операционных экранах."""
        return float(self.width_mm) * float(self.length_m) / 1000
