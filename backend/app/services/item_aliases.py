"""Синонимы любой позиции номенклатуры (14.10, models/items.py::ItemAlias).

Одно место, где текст из внешнего источника (наряд, график, счёт и прайс
1С) превращается в позицию: сначала точное название, потом синоним. Плёнка
дополнительно подбирается по своим сопоставлениям «текст → цвет плёнки»
(services/film_aliases.py) — они про цвет любого производителя и толщины,
а не про одну позицию."""

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.items import Item, ItemAlias, normalize_name


def alias_key(text: str) -> str:
    return " ".join(normalize_name(text or "").split())


def find_item(db: Session, text: str, kind_id: int | None = None) -> Item | None:
    """Позиция по тексту: название (регистр, ё, пробелы не важны) → синоним."""
    key = alias_key(text)
    if not key:
        return None
    q = db.query(Item).filter(Item.is_model.is_(False), func.replace(func.lower(func.trim(Item.name)), "ё", "е") == key)
    if kind_id is not None:
        q = q.filter(Item.kind_id == kind_id)
    item = q.order_by(Item.is_active.desc(), Item.id).first()
    if item is not None:
        return item
    q = db.query(Item).join(ItemAlias, ItemAlias.item_id == Item.id).filter(ItemAlias.alias == key)
    if kind_id is not None:
        q = q.filter(Item.kind_id == kind_id)
    return q.first()


def add_alias(db: Session, item: Item, text: str, *, source: str | None = None, user_id: int | None = None) -> ItemAlias | None:
    """Записать синоним. Совпадает с названием — не нужен (None). Уже есть у
    другой позиции — ValueError: один текст не может значить две позиции."""
    key = alias_key(text)
    if not key or key == alias_key(item.name):
        return None
    ex = db.query(ItemAlias).filter(ItemAlias.alias == key).first()
    if ex is not None:
        if ex.item_id == item.id:
            return ex
        other = db.get(Item, ex.item_id)
        raise ValueError(f"«{text.strip()}» уже синоним позиции «{other.name if other else ex.item_id}»")
    a = ItemAlias(alias=key[:255], text=" ".join(text.split())[:255], item_id=item.id, source=source, created_by=user_id)
    db.add(a)
    db.flush()
    return a
