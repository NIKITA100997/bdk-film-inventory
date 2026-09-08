"""Производственные задания (пилот: окутка царговых). Три отдельных
момента выбора: BOM (ProductModelPart) фиксирует только физическую форму
детали и участок; при создании задания выбирается номенклатура плёнки
(SKU) — material_id/color_id/thickness_id появляются только на
ProductionTaskLine; распределение по конкретным линиям/дням/сотрудникам —
отдельный шаг начальника участка поверх уже созданного задания
(ProductionTaskLineAssignment)."""

from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base


class ProductionLine(Base):
    __tablename__ = "production_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)  # "Поперечная-1", "Продольная-2"
    area: Mapped[str] = mapped_column(ForeignKey("areas.code"))
    is_active: Mapped[bool] = mapped_column(default=True)


class ProductModel(Base):
    __tablename__ = "product_models"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)  # "Дверь царговая, Прованс"
    area: Mapped[str] = mapped_column(ForeignKey("areas.code"))
    is_active: Mapped[bool] = mapped_column(default=True)
    # Раздел про калькулятор заказа — погонаж (короб/наличник/добор/плинтус
    # и т.п.) заведён в этой же таблице как обычная "модель" с одной
    # BOM-строкой, но это не дверное полотно, а сопутствующий комплект,
    # который можно добавить к дверной строке заказа. Число BOM-строк не
    # годится как признак (у щитовых дверей тоже всего одна строка), нужен
    # явный флаг; по умолчанию False, чтобы не переклассифицировать заодно
    # и щитовые двери.
    is_trim: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

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
    area: Mapped[str] = mapped_column(ForeignKey("areas.code"))

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
    # Номер заказа из наряда — отдельно от name (там он остаётся частью
    # человекочитаемого ярлыка "Заказ №8842 — ..."), нужен для поиска/
    # группировки заданий по одному заказу и как точка стыковки с 1С.
    external_order_ref: Mapped[int | None] = mapped_column(Integer, nullable=True)
    area: Mapped[str] = mapped_column(ForeignKey("areas.code"))
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Раздел про удаление сущностей — задание с историей выдачи нельзя
    # удалить (см. delete_production_task_impl в api/production.py), но
    # можно скрыть из рабочих списков.
    is_active: Mapped[bool] = mapped_column(default=True)

    lines: Mapped[list["ProductionTaskLine"]] = relationship(back_populates="task", cascade="all, delete-orphan")
    # Раздел про этикетку с назначением после резки — чтобы получить
    # название модели без отдельного запроса (api/production.py уже делает
    # это вручную через db.get, здесь нужно то же самое из lazy-контекста
    # печати этикетки, где явного db-запроса нет).
    product_model: Mapped["ProductModel | None"] = relationship()


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

    # Раздел про закрытие строки задания по выдаче — та же механика, что
    # ProductionTask.is_active выше, но на уровень строки: ручной флаг
    # "по этой строке выдача закрыта, больше ничего не ожидается", а не
    # производная от shortfall_length_m/remaining_pieces/отчётов (те
    # реальные цифры не трогаем — оставляем как исторический факт, даже
    # неполный/недостоверный). Скрывает строку из операционных списков
    # (Issue.tsx), не из административных (TasksTab.tsx показывает её
    # всегда, с пометкой).
    is_closed: Mapped[bool] = mapped_column(default=False, server_default="false")

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
    # ondelete=SET NULL — удаление задания каскадно удаляет и его
    # assignments (см. ProductionTaskLine.assignments ниже); без этого
    # удаление задания с уже отчитанным браком падало нарушением внешнего
    # ключа вместо каскада.
    assignment_id: Mapped[int | None] = mapped_column(
        ForeignKey("production_task_line_assignments.id", ondelete="SET NULL"), nullable=True
    )
    # Из какого конкретного рулона резали (раздел про цифровой аналог
    # бумажной "Ежедневки" — «№ штрипса») — nullable, обязательность по
    # участку проверяется в api/production.py (пилот: только окутка
    # царговых), а не на уровне модели. ondelete=SET NULL — тот же приём,
    # что assignment_id выше: списание/возврат рулона не должно уносить
    # за собой уже поданный отчёт.
    material_unit_id: Mapped[int | None] = mapped_column(
        ForeignKey("material_units.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Какая партия п/ф укутывалась (раздел про физический учёт деталей,
    # пилот: окутка царговых) — good_pieces из этого отчёта переводит
    # ровно столько же штук партии на следующий этап (services/
    # part_units.py::advance_part_unit), defect_pieces — списывает их же
    # (write_off_part_unit). Nullable — как material_unit_id выше, участок
    # без настроенных этапов у детали продолжает работать без партии.
    part_unit_id: Mapped[int | None] = mapped_column(
        ForeignKey("part_units.id", ondelete="SET NULL"), nullable=True, index=True
    )

    good_pieces: Mapped[float] = mapped_column(Numeric(12, 2))
    defect_pieces: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    defect_reason: Mapped[str | None] = mapped_column(ForeignKey("write_off_reasons.code"), nullable=True)
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
