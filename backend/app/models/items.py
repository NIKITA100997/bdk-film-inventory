from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, event, func
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

    kind: Mapped[ItemKind] = relationship()


KIND_FILM = "plenka"
KIND_PF = "pf"
KIND_PRODUCT = "izdelie"


def normalize_name(name: str) -> str:
    """Та же нормализация, что у sync_part_to_task_lines: регистр, пробелы
    по краям, ё/е."""
    return name.strip().lower().replace("ё", "е")


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
            key = normalize_name(obj.part_name)
            part_id = (
                session.query(Part.id)
                .filter(func.replace(func.lower(func.trim(Part.name)), "ё", "е") == key)
                .order_by(Part.id)
                .limit(1)
                .scalar()
            )
            if part_id is not None or renamed:
                obj.part_id = part_id
