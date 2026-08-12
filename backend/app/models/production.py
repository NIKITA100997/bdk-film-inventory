"""Производственные задания (пилот: окутка царговых) — разбор «N штук
модели X» на задания по производственным линиям. «Линия» здесь называет
одновременно и физическую линию, и вид детали, который она обрабатывает
(«поперечная» = и линия, и вид детали) — отдельной сущности «деталь» не
заводим, точность без пользы на пилоте. Требование плёнки на деталь — тот
же паттерн material_id+color_id+thickness_id без производителя, что и у
OrderMaterialLine: на этапе BOM конкретный SKU ещё не важен."""

from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base
from app.models.events import WriteOffReason
from app.models.users import Area


class ProductionLine(Base):
    __tablename__ = "production_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)  # "Поперечная-1", "Продольная-2"
    area: Mapped[Area] = mapped_column(Enum(Area, name="area", create_type=False))
    is_active: Mapped[bool] = mapped_column(default=True)


class ProductModel(Base):
    __tablename__ = "product_models"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)  # "Дверь царговая, Прованс"
    area: Mapped[Area] = mapped_column(Enum(Area, name="area", create_type=False))
    is_active: Mapped[bool] = mapped_column(default=True)

    parts: Mapped[list["ProductModelPart"]] = relationship(back_populates="product_model", cascade="all, delete-orphan")


class ProductModelPart(Base):
    """Строка BOM — сколько плёнки какого цвета нужно на линии X на одну
    деталь. part_name — только для читаемости в админке, в разбивке
    задания не участвует (несколько деталей на одной линии с одной плёнкой
    складываются в одну строку — см. services/production.py::explode_task)."""

    __tablename__ = "product_model_parts"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_model_id: Mapped[int] = mapped_column(ForeignKey("product_models.id"))
    line_id: Mapped[int] = mapped_column(ForeignKey("production_lines.id"))

    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id"))
    color_id: Mapped[int] = mapped_column(ForeignKey("colors.id"))
    thickness_id: Mapped[int] = mapped_column(ForeignKey("thicknesses.id"))

    qty_per_unit: Mapped[float] = mapped_column(Numeric(10, 2))
    part_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    product_model: Mapped[ProductModel] = relationship(back_populates="parts")


class ProductionTask(Base):
    """product_model_id/quantity — заполнены при создании из BOM модели;
    оба nullable — при ручном создании (пока не все модели описаны в BOM,
    строки задаются напрямую) модели и единой "штучности" нет, у каждой
    строки своё количество. name — ярлык ручного задания взамен имени
    модели. area — хранится прямо на задании (не только через модель),
    чтобы фильтр "начальник участка видит только своё" был единообразным
    для обоих способов создания."""

    __tablename__ = "production_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_model_id: Mapped[int | None] = mapped_column(ForeignKey("product_models.id"), nullable=True)
    quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)  # "500 дверей" — пусто у ручных заданий
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)  # ярлык ручного задания
    area: Mapped[Area] = mapped_column(Enum(Area, name="area", create_type=False))
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    lines: Mapped[list["ProductionTaskLine"]] = relationship(back_populates="task", cascade="all, delete-orphan")


class ProductionTaskLine(Base):
    """Развёрнутое и сгруппированное задание по линии — то, что видит
    начальник участка. Считается один раз при создании ProductionTask
    (services/production.py::explode_task) или задаётся напрямую при
    ручном создании — сама цель (quantity_pieces) не пересчитывается и не
    мутируется впоследствии; факт производства/брака — отдельный
    накопительный журнал (см. ProductionTaskLineReport), остаток считается
    на лету, а не хранится здесь."""

    __tablename__ = "production_task_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("production_tasks.id"))
    line_id: Mapped[int] = mapped_column(ForeignKey("production_lines.id"))

    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id"))
    color_id: Mapped[int] = mapped_column(ForeignKey("colors.id"))
    thickness_id: Mapped[int] = mapped_column(ForeignKey("thicknesses.id"))

    quantity_pieces: Mapped[float] = mapped_column(Numeric(12, 2))

    task: Mapped[ProductionTask] = relationship(back_populates="lines")
    reports: Mapped[list["ProductionTaskLineReport"]] = relationship(
        back_populates="task_line", cascade="all, delete-orphan"
    )


class ProductionTaskLineReport(Base):
    """Отчёт о факте производства по строке задания (раздел про брак в
    производстве) — брак обнаруживается уже в процессе окутки, на уровне
    готовых деталей, не привязан к конкретному рулону. Накопительный
    журнал, а не мутация ProductionTaskLine.quantity_pieces (тот же приём,
    что MaterialEvent для остатков) — переживает несколько отчётов по
    одной строке (например, за разные смены), не теряет историю кто и
    когда отчитался. Остаток = quantity_pieces - Σ good_pieces (см.
    api/production.py — агрегируется на лету, не хранится)."""

    __tablename__ = "production_task_line_reports"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_line_id: Mapped[int] = mapped_column(ForeignKey("production_task_lines.id"))

    good_pieces: Mapped[float] = mapped_column(Numeric(12, 2))
    defect_pieces: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    defect_reason: Mapped[WriteOffReason | None] = mapped_column(
        Enum(WriteOffReason, name="write_off_reason", create_type=False), nullable=True
    )
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)

    reported_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    reported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    task_line: Mapped[ProductionTaskLine] = relationship(back_populates="reports")
