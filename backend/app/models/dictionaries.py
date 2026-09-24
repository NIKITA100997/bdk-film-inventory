"""Справочники атрибутов (2.1a ТЗ) — материал/цвет/толщина/производитель не
текстовые поля, а ссылки на эти четыре справочника, чтобы "Дуб беленый" и
"Дуб белёный" не расползались на два разных значения. MaterialSku — позиция
материала: конкретная комбинация значений из всех четырёх + данные
поставщика."""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base
from app.models.items import Item  # noqa: F401 — для relationship("Item")


class Material(Base):
    __tablename__ = "materials"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Color(Base):
    __tablename__ = "colors"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Thickness(Base):
    __tablename__ = "thicknesses"

    id: Mapped[int] = mapped_column(primary_key=True)
    value_mm: Mapped[float] = mapped_column(Numeric(10, 3), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Manufacturer(Base):
    __tablename__ = "manufacturers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Employee(Base):
    """Сотрудники цеха (раздел про автокомплит вместо голого текста) — не
    учётная запись (`User`), цеховые рабочие обычно без логина в систему,
    только имя для распределения по линиям/дням (ProductionTaskLineAssignment
    .employee_names)."""

    __tablename__ = "employees"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Part(Base):
    """Справочник деталей (раздел про выбор детали в задание) — физическая
    форма детали (ширина/длина/ширина штрипса плёнки для укутки), без
    количества на изделие — это уже атрибут конкретной строки BOM
    (ProductModelPart)/задания (ProductionTaskLine), не самой детали как
    таковой. Не FK-связь с ними — источник подсказки для автозаполнения
    формы, сама строка BOM/задания как была текстом/числами, так и осталась.

    `area` — необязательная привязка к одному участку (раздел про
    привязку деталей к участку — справочник разросся за счёт нескольких
    разных наборов деталей от разных участков, PartSelect фильтрует по
    ней), NULL — деталь общая, показывается независимо от участка.

    `default_material_sku_id` — раздел про закрепление плёнки за деталью:
    материал при загрузке задания из файла обычно подбирается по тексту
    цвета в файле (см. services/sku_matching.py), но для некоторых деталей
    один и тот же текст ("Белый") может значить РАЗНУЮ плёнку в
    зависимости от самой детали (реальный случай — ПЭТ 2Д/3Д, текст файла
    их никак не различает). Когда закреплено — подбор по тексту цвета не
    нужен вовсе, деталь всегда предлагает именно эту позицию."""

    __tablename__ = "parts"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    width_mm: Mapped[float] = mapped_column(Numeric(10, 2))
    length_m: Mapped[float] = mapped_column(Numeric(12, 3))
    strip_width_mm: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    area: Mapped[str | None] = mapped_column(ForeignKey("areas.code"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    default_material_sku_id: Mapped[int | None] = mapped_column(ForeignKey("material_skus.id"), nullable=True)
    # Раздел про потребность п/ф — ниже минимального остатка детали
    # предлагается задание на производство, не меньше минимальной партии
    # (см. services/pf_demand.py). NULL — не задано.
    min_stock_pieces: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    min_batch_pieces: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    # Раздел про единую номенклатуру — запись номенклатуры вида «П/ф»
    # (создаётся сама, см. app/models/items.py).
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id"), nullable=True, unique=True)

    item: Mapped["Item | None"] = relationship()
    default_material_sku: Mapped["MaterialSku | None"] = relationship(foreign_keys=[default_material_sku_id])
    stages: Mapped[list["PartStage"]] = relationship(
        back_populates="part", order_by="PartStage.sequence_order", cascade="all, delete-orphan"
    )


class PartStage(Base):
    """Этапы обработки детали (раздел про физический учёт п/ф → заготовка)
    — свой упорядоченный список у КАЖДОЙ детали отдельно (не общий enum на
    все детали разом), потому что путь у разных деталей может отличаться:
    у одной "П/ф" → "Заготовка", у другой позже может появиться третий шаг
    ("Просверлено" и т.п.) — добавить его этой конкретной детали — одна
    новая строка, без миграции схемы. PartUnit.stage_id ссылается сюда.

    `area` — раздел про связь этапов с реальными участками: этап это не
    просто текстовая строка, а конкретный участок цеха, где эта работа
    физически выполняется (тот же справочник Area, что и у производственных
    заданий). NULL — участок для этапа ещё не назначен (старые данные,
    либо этап без физической выдачи, например «Готово»); выдача участку
    (`issue_part_unit`/`advance_part_unit`) требует, чтобы он был задан —
    участок для выдачи выводится ИЗ этапа, не выбирается вручную."""

    __tablename__ = "part_stages"
    __table_args__ = (
        UniqueConstraint("part_id", "sequence_order", name="uq_part_stage_order"),
        UniqueConstraint("item_id", "sequence_order", name="uq_part_stage_item_order"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # Единая модель, пункт 3 — операция маршрута ЛЮБОЙ позиции номенклатуры
    # (item_id); part_id — только у детали п/ф (у изделия операции без детали).
    # Таблица пока называется part_stages: на неё ссылаются партии п/ф.
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"), index=True)
    part_id: Mapped[int | None] = mapped_column(ForeignKey("parts.id", ondelete="CASCADE"), nullable=True, index=True)
    sequence_order: Mapped[int] = mapped_column()
    code: Mapped[str] = mapped_column(String(50))
    name: Mapped[str] = mapped_column(String(255))
    area: Mapped[str | None] = mapped_column(ForeignKey("areas.code"), nullable=True)

    part: Mapped[Part | None] = relationship(back_populates="stages")
    item: Mapped["Item"] = relationship(back_populates="stages")


class MaterialSku(Base):
    """Позиция материала (5.6 ТЗ) — конкретная комбинация материал+цвет+
    толщина+производитель, а не текст. `native_width_mm` — родная ширина
    рулона от поставщика, используется автоподбором места (4.2), чтобы
    отличить целый рулон от штрипса."""

    __tablename__ = "material_skus"
    __table_args__ = (UniqueConstraint("material_id", "color_id", "thickness_id", "manufacturer_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id"))
    color_id: Mapped[int] = mapped_column(ForeignKey("colors.id"))
    thickness_id: Mapped[int] = mapped_column(ForeignKey("thicknesses.id"))
    manufacturer_id: Mapped[int] = mapped_column(ForeignKey("manufacturers.id"))
    supplier_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    native_width_mm: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    # Путь фото плёнки на диске сервера (8 раздел обратной связи), относительно
    # UPLOAD_DIR — отдаётся статикой, во внешнем хранилище нужды пока нет.
    photo_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Раздел про единую номенклатуру — запись вида «Плёнка».
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id"), nullable=True, unique=True)

    item: Mapped["Item | None"] = relationship()
    material: Mapped[Material] = relationship()
    color: Mapped[Color] = relationship()
    thickness: Mapped[Thickness] = relationship()
    manufacturer: Mapped[Manufacturer] = relationship()

    @property
    def display_name(self) -> str:
        return f"{self.material.name}, {self.color.name}, {self.thickness.value_mm} мм, {self.manufacturer.name}"


class SkuAnalog(Base):
    """Ручная привязка аналогов между позициями номенклатуры (8 раздел
    обратной связи) — заводит логист/админ, не автоматика по атрибутам.
    Связь ненаправленная по смыслу (A аналог B ⇒ B аналог A), но хранится
    один раз как направленная пара; читается в обе стороны — см.
    services/analogs.list_analogs_for_sku."""

    __tablename__ = "sku_analogs"
    __table_args__ = (UniqueConstraint("sku_id", "analog_sku_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    sku_id: Mapped[int] = mapped_column(ForeignKey("material_skus.id"))
    analog_sku_id: Mapped[int] = mapped_column(ForeignKey("material_skus.id"))
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    sku: Mapped[MaterialSku] = relationship(foreign_keys=[sku_id])
    analog_sku: Mapped[MaterialSku] = relationship(foreign_keys=[analog_sku_id])
