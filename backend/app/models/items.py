import re
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint, event, func
from sqlalchemy.orm import Mapped, Session, attributes, mapped_column, relationship

from app.db.base import Base


class ItemKind(Base):
    """Вид номенклатуры (раздел про единую номенклатуру) — плёнка, п/ф,
    изделие…: в чём учитывается позиция и ведётся ли она партиями. Как «Вид
    номенклатуры»/«Категория» в 1С: новый вид — строка справочника, а не
    новая таблица и новый экран под каждую задачу."""

    __tablename__ = "item_kinds"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    unit: Mapped[str] = mapped_column(String(16))
    lot_tracking: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Item(Base):
    """Номенклатура — одна запись на любую позицию, независимо от вида.

    На первом этапе перехода это общий «хаб»: позиции плёнки, детали п/ф и
    модели продукции остаются в своих таблицах и ссылаются сюда (item_id),
    старые экраны работают как раньше. Название в списке берётся из
    исходной таблицы (там оно правится), name здесь — снимок на момент
    создания и запасной вариант для будущих видов без своей таблицы.
    code_1c — под будущее сопоставление с 1С:УНФ, пока пустое."""

    __tablename__ = "items"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind_id: Mapped[int] = mapped_column(ForeignKey("item_kinds.id"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    code_1c: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Тип изделия внутри вида (ГП → «Щитовая дверь»…): задаёт набор свойств
    # позиции. NULL — тип не назначен (плёнка, п/ф пока без типов).
    type_id: Mapped[int | None] = mapped_column(ForeignKey("item_types.id"), nullable=True, index=True)

    kind: Mapped[ItemKind] = relationship()
    type: Mapped["ItemType | None"] = relationship()


class ItemType(Base):
    """Тип изделия внутри вида номенклатуры (единая модель, пункт 1) —
    «Щитовая дверь», «Царговая дверь», «Металлическая дверь» внутри ГП.
    Новый тип — строка справочника с настройками (свойства, позже —
    маршрут и правила состава), а не новая таблица и новый экран."""

    __tablename__ = "item_types"
    __table_args__ = (UniqueConstraint("kind_id", "name", name="uq_item_types_kind_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    kind_id: Mapped[int] = mapped_column(ForeignKey("item_kinds.id"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    kind: Mapped[ItemKind] = relationship()
    properties: Mapped[list["ItemProperty"]] = relationship(
        back_populates="type", order_by="ItemProperty.sort_order", cascade="all, delete-orphan"
    )


PROPERTY_VALUE_TYPES = ("number", "text", "bool", "list")


class ItemProperty(Base):
    """Свойство (характеристика) типа изделия (единая модель, пункт 2) —
    «Ширина, мм», «Серия», «Кромка»… value_type: number / text / bool / list.

    У свойства-списка варианты могут нести свои параметры: option_fields —
    описание полей [{"code", "name", "value_type"}], значения — в
    ItemPropertyOption.params. Так серия щитовой двери хранит толщину
    каркаса/панели и кромку, и правила состава смогут на них ссылаться."""

    __tablename__ = "item_properties"
    __table_args__ = (UniqueConstraint("type_id", "code", name="uq_item_properties_type_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    type_id: Mapped[int] = mapped_column(ForeignKey("item_types.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(128))
    value_type: Mapped[str] = mapped_column(String(16))
    unit: Mapped[str | None] = mapped_column(String(16), nullable=True)
    is_required: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    option_fields: Mapped[list] = mapped_column(JSON, default=list)

    type: Mapped[ItemType] = relationship(back_populates="properties")
    options: Mapped[list["ItemPropertyOption"]] = relationship(
        back_populates="property", order_by="ItemPropertyOption.sort_order", cascade="all, delete-orphan"
    )


class ItemPropertyOption(Base):
    """Вариант свойства-списка («В-10» у серии) и значения его параметров."""

    __tablename__ = "item_property_options"
    __table_args__ = (UniqueConstraint("property_id", "value", name="uq_item_property_options_value"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    property_id: Mapped[int] = mapped_column(ForeignKey("item_properties.id", ondelete="CASCADE"), index=True)
    value: Mapped[str] = mapped_column(String(128))
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    property: Mapped[ItemProperty] = relationship(back_populates="options")


class ItemPropertyValue(Base):
    """Значение свойства у позиции номенклатуры. Заполнено одно поле — по
    типу свойства (list — option_id)."""

    __tablename__ = "item_property_values"

    item_id: Mapped[int] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"), primary_key=True)
    property_id: Mapped[int] = mapped_column(ForeignKey("item_properties.id", ondelete="CASCADE"), primary_key=True)
    value_number: Mapped[float | None] = mapped_column(Numeric(14, 4), nullable=True)
    value_text: Mapped[str | None] = mapped_column(String(255), nullable=True)
    value_bool: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    option_id: Mapped[int | None] = mapped_column(ForeignKey("item_property_options.id"), nullable=True)


KIND_FILM = "plenka"
KIND_PF = "pf"
KIND_PRODUCT = "izdelie"


def normalize_name(name: str) -> str:
    """Та же нормализация, что у sync_part_to_task_lines: регистр, пробелы
    по краям, ё/е."""
    return name.strip().lower().replace("ё", "е")


_SIZE_IN_NAME = re.compile(r"\d+([.,]\d+)?\s*[хxХX×*]\s*\d+")


def fmt_num(v: float) -> str:
    return f"{float(v):g}"


def size_part_name(part_name: str, width_mm: float, length_m: float) -> str:
    """Название позиции на размер (решение 24.09: отдельная позиция на
    размер): «Поперечная (МежКомн) 110х404». Если размер уже в названии
    (как в 1С: «Добор телескоп 10*100*2070») — как есть."""
    name = " ".join(part_name.split())
    if _SIZE_IN_NAME.search(name):
        return name
    return f"{name} {fmt_num(width_mm)}х{fmt_num(round(float(length_m) * 1000, 1))}"


def sku_item_name(material: str, color: str, thickness_mm: float, manufacturer: str) -> str:
    return f"{material}, {color}, {float(thickness_mm):g} мм, {manufacturer}"


@event.listens_for(Session, "before_flush")
def _link_items_and_parts(session: Session, flush_context, instances) -> None:
    """Единая точка связей номенклатуры — ловит ЛЮБОЙ путь создания/правки
    (справочники, загрузка нарядов и планов, запуск щитовых), а не только
    ручные экраны:
      • новая позиция плёнки / деталь / модель продукции получает запись
        номенклатуры своего вида;
      • строка BOM модели и строка задания цеха получают ссылку на деталь по
        названию, если ссылки нет или название поменяли (переименование
        самой детали ссылку не рвёт — поэтому и нужна ссылка вместо текста)."""
    from app.models.dictionaries import Color, Manufacturer, Material, MaterialSku, Part, Thickness
    from app.models.production import ProductionTaskLine, ProductModel, ProductModelPart

    kinds: dict[str, int] | None = None

    def kind_id(code: str) -> int | None:
        nonlocal kinds
        if kinds is None:
            kinds = {k.code: k.id for k in session.query(ItemKind)}
        return kinds.get(code)

    with session.no_autoflush:
        for obj in list(session.new):
            if isinstance(obj, Part) and obj.item_id is None and obj.item is None:
                kid = kind_id(KIND_PF)
                if kid:
                    obj.item = Item(kind_id=kid, name=obj.name)
            elif isinstance(obj, ProductModel) and obj.item_id is None and obj.item is None:
                kid = kind_id(KIND_PRODUCT)
                if kid:
                    obj.item = Item(kind_id=kid, name=obj.name)
            elif isinstance(obj, MaterialSku) and obj.item_id is None and obj.item is None:
                kid = kind_id(KIND_FILM)
                if kid:
                    material = obj.material or session.get(Material, obj.material_id)
                    color = obj.color or session.get(Color, obj.color_id)
                    thickness = obj.thickness or session.get(Thickness, obj.thickness_id)
                    manufacturer = obj.manufacturer or session.get(Manufacturer, obj.manufacturer_id)
                    name = sku_item_name(material.name, color.name, thickness.value_mm, manufacturer.name)
                    obj.item = Item(kind_id=kid, name=name)

        for obj in list(session.deleted):
            if isinstance(obj, (Part, ProductModel, MaterialSku)) and obj.item_id is not None:
                item = session.get(Item, obj.item_id)
                if item is not None:
                    session.delete(item)

        for obj in list(session.new) + list(session.dirty):
            if not isinstance(obj, (ProductModelPart, ProductionTaskLine)) or not obj.part_name:
                continue
            renamed = attributes.get_history(obj, "part_name").has_changes() and obj not in session.new
            if obj.part_id is not None and not renamed:
                continue
            # По названию; не нашлось — позиция на этот размер под общим
            # названием («Поперечная (МежКомн)» 110×404 → «… 110х404»).
            keys = [normalize_name(obj.part_name)]
            if obj.width_mm is not None and obj.length_m is not None:
                keys.append(normalize_name(size_part_name(obj.part_name, obj.width_mm, obj.length_m)))
            part_id = None
            for key in dict.fromkeys(keys):
                part_id = (
                    session.query(Part.id)
                    .filter(func.replace(func.lower(func.trim(Part.name)), "ё", "е") == key)
                    .order_by(Part.id)
                    .limit(1)
                    .scalar()
                )
                if part_id is not None:
                    break
            if part_id is not None or renamed:
                obj.part_id = part_id
