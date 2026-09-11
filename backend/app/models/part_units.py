import enum
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Enum, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base
from app.models.dictionaries import Part, PartStage


class PartUnitStatus(str, enum.Enum):
    NA_KHRANENII = "На_хранении"
    VYDAN_UCHASTKU = "Выдан_участку"
    SPISAN = "Списан"


class PartUnit(Base):
    """Физическая партия деталей (лот в штуках, не поштучно-серийный учёт —
    зеркалит MaterialUnit, backend/app/models/units.py, но количество
    вместо метров и текущий этап обработки вместо ширины/длины).

    status и stage_id — две независимые оси: status — где партия физически
    находится прямо сейчас (на хранении/выдана участку/списана), stage_id —
    до какого этапа обработки она уже дошла (свой список этапов у каждой
    детали, см. PartStage). Партия может быть списана что на первом этапе
    («П/ф»), что на любом следующем — списание не привязано к конкретному
    этапу."""

    __tablename__ = "part_units"

    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("part_units.id"), nullable=True)

    part_id: Mapped[int] = mapped_column(ForeignKey("parts.id"), index=True)
    part: Mapped[Part] = relationship()

    quantity_pieces: Mapped[float] = mapped_column(Numeric(12, 2))

    stage_id: Mapped[int] = mapped_column(ForeignKey("part_stages.id"))
    stage: Mapped[PartStage] = relationship()

    status: Mapped[PartUnitStatus] = mapped_column(Enum(PartUnitStatus, name="part_unit_status"))
    area: Mapped[str | None] = mapped_column(ForeignKey("areas.code"), nullable=True)

    # Свободный текст на первую версию (раздел про физический учёт деталей,
    # пилот: окутка царговых) — без отдельных стеллажей/полок для п/ф, как
    # уже есть у плёнки (Rack/StorageMap) — добавить адресное хранение
    # отдельным шагом, если появится реальная потребность.
    location_code: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Раздел про производственные задания — для какой строки задания
    # нарезана партия (тег для прослеживаемости, как у MaterialUnit); NULL —
    # безадресный запас, нарезанный заранее.
    production_task_line_id: Mapped[int | None] = mapped_column(
        ForeignKey("production_task_lines.id", ondelete="SET NULL"), nullable=True, index=True
    )

    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))

    # Раздел про учёт п/ф по FIFO — отдельно от created_at (момент записи
    # в систему, часто позже реального изготовления, см. mint_part_unit
    # "регистрация задним числом"): дата, по которой партии расходуются
    # от самой старой. _split_or_reuse копирует её в дочернюю партию при
    # дроблении — иначе FIFO-порядок ломался бы на первом же частичном
    # расходе (дочерняя партия получила бы "сегодня").
    manufactured_at: Mapped[date] = mapped_column(Date, server_default=func.current_date())

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    parent: Mapped["PartUnit | None"] = relationship(remote_side=[id])


class PartEventType(str, enum.Enum):
    PROIZVODSTVO = "Производство"
    RAZMESHCHENIE = "Размещение"
    VYDACHA_UCHASTKU = "Выдача_участку"
    PEREKHOD_ETAPA = "Переход_этапа"
    SPISANIE = "Списание"
    ZAVERSHENIE = "Завершение"
    # Раздел про ревизию путей плёнки/п/ф — зеркалит MaterialEvent:
    # VOZVRAT — партию физически вернули на склад, не использовав (или
    # использовав частично), не через списание; KORREKTIROVKA —
    # формальная правка quantity_pieces (POST /part-units/{id}/adjust)
    # вместо правки истории напрямую в БД.
    VOZVRAT = "Возврат"
    KORREKTIROVKA = "Корректировка"


class PartUnitEvent(Base):
    """Журнал движений партии (зеркалит MaterialEvent,
    backend/app/models/events.py) — единая точка записи из сервисного слоя
    (services/part_units.py::record_part_event), не из роутеров напрямую."""

    __tablename__ = "part_unit_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    part_unit_id: Mapped[int] = mapped_column(ForeignKey("part_units.id"), index=True)

    event_type: Mapped[PartEventType] = mapped_column(Enum(PartEventType, name="part_event_type"))
    quantity_delta: Mapped[float] = mapped_column(Numeric(12, 2))

    from_stage_id: Mapped[int | None] = mapped_column(ForeignKey("part_stages.id"), nullable=True)
    to_stage_id: Mapped[int | None] = mapped_column(ForeignKey("part_stages.id"), nullable=True)

    # Раздел про адресное хранение п/ф — ячейка стеллажа п/ф до/после
    # события "Размещение" (зеркалит MaterialEvent.from_cell/to_cell).
    from_cell: Mapped[str | None] = mapped_column(String(64), nullable=True)
    to_cell: Mapped[str | None] = mapped_column(String(64), nullable=True)

    area: Mapped[str | None] = mapped_column(ForeignKey("areas.code"), nullable=True)
    production_task_line_id: Mapped[int | None] = mapped_column(
        ForeignKey("production_task_lines.id", ondelete="SET NULL"), nullable=True
    )

    write_off_reason: Mapped[str | None] = mapped_column(ForeignKey("write_off_reasons.code"), nullable=True)
    write_off_note: Mapped[str | None] = mapped_column(String(255), nullable=True)

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
