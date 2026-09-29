"""Признаки позиции номенклатуры: направление, стадия, режим.

Направление и стадия задаются у типа, у позиции — только исключения
(пусто = как у типа). Режим «под заказ / на склад» по умолчанию выводится
из направления и стадии, у позиции можно переопределить.
"""

from app.models.items import Item, ItemType

DIRECTIONS = {
    "shield": "Щитовые",
    "tsarg": "Царговые",
    "panel": "Панели (мет. двери)",
    "trim": "Погонаж",
}
STAGES = {
    "blank": "Заготовка",
    "bare": "Деталь без плёнки",
    "laminated": "Деталь в плёнке",
    "stripped": "После снятия плёнки",
}
MODES = {"order": "Под заказ", "stock": "На склад"}

# Щиты и панели — только под заказ (ответ пользователя 29.09).
ORDER_ONLY_DIRECTIONS = {"shield", "panel"}


def effective_direction(item: Item, item_type: ItemType | None) -> str | None:
    return item.direction or (item_type.direction if item_type else None)


def effective_stage(item: Item, item_type: ItemType | None) -> str | None:
    return item.stage or (item_type.stage if item_type else None)


def default_mode(kind_code: str, direction: str | None, stage: str | None) -> str | None:
    """Под заказ / на склад по умолчанию. Плёнка и материалы — закупаются,
    режима нет. Изделие — под заказ. П/ф: щиты и панели — под заказ; в
    плёнке — под заказ (излишки всё равно уходят в остаток); заготовки,
    детали без плёнки и после снятия — на склад."""
    if kind_code == "izdelie":
        return "order"
    if kind_code != "pf":
        return None
    if direction in ORDER_ONLY_DIRECTIONS:
        return "order"
    if stage == "laminated":
        return "order"
    return "stock"


def effective_mode(item: Item, kind_code: str, item_type: ItemType | None) -> str | None:
    if item.make_mode:
        return item.make_mode
    return default_mode(kind_code, effective_direction(item, item_type), effective_stage(item, item_type))
