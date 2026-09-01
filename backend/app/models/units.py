import enum
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base
from app.models.dictionaries import MaterialSku
from app.models.production import ProductionTaskLine


class UnitStatus(str, enum.Enum):
    PRINYAT = "Принят"
    NA_KHRANENII = "На_хранении"
    VYDAN_UCHASTKU = "Выдан_участку"
    SPISAN = "Списан"
    # Раздел про перемещение между складами — единица уже отмечена под
    # другой склад (в хабе либо уже физически отправлена), но ещё не
    # принята на месте назначения. Отдельный статус, а не флаг поверх
    # На_хранении, специально: так единица автоматически перестаёт
    # попадать во все существующие фильтры по NA_KHRANENII (поиск донора,
    # план резки, отчёты, инвентаризация) без единой правки в этих местах.
    V_PEREMESHCHENII = "В_перемещении"


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

    # Явный тип единицы (раздел про приёмку отдельных штрипсов) — раньше
    # выводился на лету (родная ширина позиции материала либо наличие
    # parent_id, см. services/placement.py::determine_rack_type), из-за
    # чего не было прямого способа завести штрипс без родителя (например,
    # уже нарезанный поставщиком). Источник истины для размещения
    # (рулонный/штрипсовый стеллаж) и для вида этикетки.
    is_strip: Mapped[bool] = mapped_column(Boolean, default=False)

    status: Mapped[UnitStatus] = mapped_column(Enum(UnitStatus, name="unit_status"))
    area: Mapped[str | None] = mapped_column(ForeignKey("areas.code"), nullable=True)

    # Полный адрес ячейки, пока единица физически на складе: "Р-3-07" или
    # "Ш-2-04-06" (раздел 4.1). Пусто, если выдана участку или ещё не размещена.
    location_code: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # Раздел про производственные задания — какую строку задания закрывает
    # выдача этой единицы (тег для прослеживаемости, копируется в
    # MaterialEvent при выдаче — см. services/events.py::record_event).
    production_task_line_id: Mapped[int | None] = mapped_column(
        ForeignKey("production_task_lines.id"), nullable=True
    )
    # Раздел про этикетку с назначением после резки — чтобы на бирке можно
    # было показать, для какого задания/детали эта конкретная единица (у
    # нескольких штрипсов одной ширины с разным назначением бирки иначе
    # неотличимы на глаз).
    production_task_line: Mapped["ProductionTaskLine | None"] = relationship()

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # Раздел про отмену резки — какой вызов /units/cutting-recipe породил
    # именно эту единицу (тег, не владеющая связь, ondelete=SET NULL — сама
    # единица переживает удаление заголовка операции). Отмена находит все
    # единицы с этим id и удаляет их вместе с заголовком за одну транзакцию.
    created_by_cutting_operation_id: Mapped[int | None] = mapped_column(
        ForeignKey("cutting_operations.id", ondelete="SET NULL"), nullable=True, index=True
    )

    parent: Mapped["MaterialUnit | None"] = relationship(remote_side=[id])

    @property
    def area_m2(self) -> float:
        """Вычисляемое поле, не хранится (раздел 2.1/2.2 ТЗ) — используется
        только в агрегированной отчётности, не в операционных экранах."""
        return float(self.width_mm) * float(self.length_m) / 1000
