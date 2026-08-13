"""Производственные задания (пилот: окутка царговых). Три отдельных
момента выбора: BOM (ProductModelPart) фиксирует только физическую форму
детали и участок; при создании задания выбирается номенклатура плёнки
(SKU) — material_id/color_id/thickness_id появляются только на
ProductionTaskLine; распределение по конкретным линиям/дням/сотрудникам —
отдельный шаг начальника участка поверх уже созданного задания
(ProductionTaskLineAssignment)."""

from datetime import date, datetime

from sqlalchemy import Date, DateTime, Enum, ForeignKey, Integer, Numeric, String
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
    """Строка BOM — физическая форма детали (сколько штук на изделие,
    какого размера кусок плёнки на неё) и участок, где её делают. Ни
    материал/цвет плёнки, ни конкретная линия здесь не фиксируются — это
    решается заново при создании конкретного задания (материал/цвет —
    выбором номенклатуры) и при распределении по линиям (начальник
    участка, по дням) соответственно, BOM про них не знает."""

    __tablename__ = "product_model_parts"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_model_id: Mapped[int] = mapped_column(ForeignKey("product_models.id"))
    area: Mapped[Area] = mapped_column(Enum(Area, name="area", create_type=False))

    qty_per_unit: Mapped[float] = mapped_column(Numeric(10, 2))
    width_mm: Mapped[float] = mapped_column(Numeric(10, 2))
    length_m: Mapped[float] = mapped_column(Numeric(12, 3))
    strip_width_mm: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
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
    # Заказ, для которого создано задание (раздел про потребности по всему
    # заказу) — необязательно, как product_model_id/quantity: не все
    # задания шьются под конкретный заказ покупателя.
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    lines: Mapped[list["ProductionTaskLine"]] = relationship(back_populates="task", cascade="all, delete-orphan")


class ProductionTaskLine(Base):
    """Строка задания — то, что видит начальник участка, сразу с
    конкретной номенклатурой плёнки (material/color/thickness выбраны при
    создании задания, не берутся из BOM). line_id — NULL при создании:
    задание ставится начальником цеха на участок (ProductionTask.area),
    без привязки к конкретной линии/станку; линию, дни и людей распределяет
    начальник участка отдельно (см. ProductionTaskLineAssignment) — сама
    цель (quantity_pieces) не пересчитывается и не мутируется впоследствии;
    факт производства/брака — отдельный накопительный журнал (см.
    ProductionTaskLineReport), остаток считается на лету, а не хранится
    здесь."""

    __tablename__ = "production_task_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("production_tasks.id"))
    line_id: Mapped[int | None] = mapped_column(ForeignKey("production_lines.id"), nullable=True)

    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id"))
    color_id: Mapped[int] = mapped_column(ForeignKey("colors.id"))
    thickness_id: Mapped[int] = mapped_column(ForeignKey("thicknesses.id"))

    quantity_pieces: Mapped[float] = mapped_column(Numeric(12, 2))
    # Раздел про размер детали — ширина/длина куска плёнки НА ОДНУ деталь
    # (не на всю строку); склад видит их на "Выдаче участку", чтобы знать,
    # какого размера штрипс резать/выдавать под эту строку задания.
    width_mm: Mapped[float] = mapped_column(Numeric(10, 2))
    length_m: Mapped[float] = mapped_column(Numeric(12, 3))
    strip_width_mm: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    # Название детали (раздел про распределение по линиям) — "Стоевая",
    # "Поперечная" и т.п., чтобы строки задания различались не только по
    # цифрам размера; переносится из ProductModelPart.part_name при
    # создании из BOM, необязательно при ручном вводе.
    part_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    task: Mapped[ProductionTask] = relationship(back_populates="lines")
    reports: Mapped[list["ProductionTaskLineReport"]] = relationship(
        back_populates="task_line", cascade="all, delete-orphan"
    )
    assignments: Mapped[list["ProductionTaskLineAssignment"]] = relationship(
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
    # Привязка к конкретной записи распределения (раздел про брак по дням)
    # — с этой доработки отчёт всегда за конкретный день/линию/смену, не
    # размазан по всей строке задания. Nullable — отчёты, заведённые до
    # этой доработки, остаются без привязки, задним числом не проставляем.
    assignment_id: Mapped[int | None] = mapped_column(ForeignKey("production_task_line_assignments.id"), nullable=True)

    good_pieces: Mapped[float] = mapped_column(Numeric(12, 2))
    defect_pieces: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    defect_reason: Mapped[WriteOffReason | None] = mapped_column(
        Enum(WriteOffReason, name="write_off_reason", create_type=False), nullable=True
    )
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)

    reported_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    reported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    task_line: Mapped[ProductionTaskLine] = relationship(back_populates="reports")


class ProductionTaskLineAssignment(Base):
    """Распределение строки задания по линиям/дням (раздел про
    распределение по линиям) — отдельный шаг начальника участка поверх уже
    поставленного задания: когда, на какой линии, какими силами и сколько
    штук берётся в работу. Накопительный список, как и отчёты о браке —
    несколько записей на одну строку задания (разные дни/линии), сумма
    quantity_pieces по ним — это "уже распределено" (см. api/production.py,
    агрегируется на лету)."""

    __tablename__ = "production_task_line_assignments"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_line_id: Mapped[int] = mapped_column(ForeignKey("production_task_lines.id"))
    line_id: Mapped[int] = mapped_column(ForeignKey("production_lines.id"))

    date: Mapped[date] = mapped_column(Date)
    # Свободный текст, не FK на users — цеховые рабочие на линии обычно без
    # логина в систему (см. обсуждение раздела про распределение).
    employee_names: Mapped[str] = mapped_column(String(255))
    quantity_pieces: Mapped[float] = mapped_column(Numeric(12, 2))

    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    task_line: Mapped[ProductionTaskLine] = relationship(back_populates="assignments")
