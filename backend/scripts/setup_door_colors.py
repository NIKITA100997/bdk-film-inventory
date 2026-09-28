"""Цвет щитовой двери — из списка с привязкой к плёнке (решение
пользователя 28.09.2026).

Свойство «цвет» типа «Щитовая дверь» — список вместо свободного текста:
название варианта — прежнее, коммерческое (названия дверей не меняются),
параметры — материал и цвет плёнки из справочника. ПЭТ 2Д/3Д — у
конкретной детали, поэтому у «silk»-цветов материал просто «ПЭТ».
Панели по цвету получают закреплённую плёнку, если она одна
(type_rules.pin_film); иначе плёнку выбирают у детали.

Повторяемо. Запуск из backend/:
    .venv/Scripts/python.exe scripts/setup_door_colors.py          # проверка
    .venv/Scripts/python.exe scripts/setup_door_colors.py --apply  # записать"""

import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, ".")

from app.db.session import SessionLocal  # noqa: E402
from app.models.dictionaries import Part  # noqa: E402
from app.models.items import Item, ItemPropertyOption, ItemPropertyValue, ItemType  # noqa: E402
from app.services import type_rules  # noqa: E402

TYPE_NAME = "Щитовая дверь"
FIELDS = [
    {"code": type_rules.FILM_MATERIAL, "name": "Материал плёнки", "value_type": "text"},
    {"code": type_rules.FILM_COLOR, "name": "Цвет плёнки", "value_type": "text"},
]
# коммерческий цвет → (материал плёнки, цвет плёнки); ответы пользователя 28.09
FILM = {
    "пэт бежевый (cream silk)": ("ПЭТ", "Бежевый"),
    "пэт светло-серый (gray silk)": ("ПЭТ", "Светло-серый"),
    "пэт светло-коричневый (clay silk)": ("ПЭТ", "Светло-коричневый"),
    "пэт белый": ("ПЭТ 2Д", "Белый"),
    "эмалит белый": ("ПВХ", "Эмалит Белый"),
    "манхэттен": ("Полипропилен", "Манхэттен"),
    "бетон тёмный вдм": ("ПВХ", "Бетон темный"),
}

apply = "--apply" in sys.argv
db = SessionLocal()
t = db.query(ItemType).filter(ItemType.name == TYPE_NAME).one()
prop = next(p for p in t.properties if p.code == type_rules.COLOR_CODE)
items = db.query(Item).filter(Item.type_id == t.id, Item.is_model.is_(False)).all()
names_before = {i.id: i.name for i in items}

if prop.value_type == "list":
    print("Цвет уже список — перевод не нужен")
else:
    values = db.query(ItemPropertyValue).filter(ItemPropertyValue.property_id == prop.id).all()
    distinct = sorted({(v.value_text or "").strip() for v in values if (v.value_text or "").strip()})
    prop.option_fields = FIELDS
    options: dict[str, ItemPropertyOption] = {}
    for i, text in enumerate(distinct, start=1):
        film = FILM.get(text.lower())
        params = {type_rules.FILM_MATERIAL: film[0], type_rules.FILM_COLOR: film[1]} if film else {}
        opt = ItemPropertyOption(value=text, params=params, is_active=True, sort_order=i)
        prop.options.append(opt)
        options[text.lower()] = opt
        print(f"  цвет: {text} → {' · '.join(film) if film else 'БЕЗ ПРИВЯЗКИ К ПЛЁНКЕ'}")
    db.flush()
    for v in values:
        text = (v.value_text or "").strip()
        v.option_id = options[text.lower()].id if text else None
        v.value_text = None
    prop.value_type = "list"
    db.flush()
    print(f"Значений переведено: {len(values)}")

# Правила заново: названия те же, панелям — закреплённая плёнка.
db.expire_all()
bad = 0
for item in db.query(Item).filter(Item.type_id == t.id, Item.is_model.is_(False)).order_by(Item.name):
    sp = db.begin_nested()
    res = type_rules.apply(db, item)
    if res.errors:
        sp.rollback()
        bad += 1
        print(f"  ошибка: {item.name}: {res.errors[0]}")
    else:
        sp.commit()
        if item.name != names_before.get(item.id, item.name):
            print(f"  ИЗМЕНИЛОСЬ НАЗВАНИЕ: {names_before[item.id]} → {item.name}")
print(f"Дверей: {len(items)}, с ошибками правил: {bad}")

panels = db.query(Part).filter(Part.name.like("%Панель щитовой двери%"), Part.is_active.is_(True)).all()
pinned = [p for p in panels if p.default_material_sku_id]
print(f"Панелей: {len(panels)}, с закреплённой плёнкой: {len(pinned)}")
for p in pinned:
    s = p.default_material_sku
    print(f"  {p.name} → {s.material.name}, {s.color.name}, {float(s.thickness.value_mm):g}, {s.manufacturer.name}")

if apply:
    db.commit()
    print("Записано.")
else:
    db.rollback()
    print("Проверка — ничего не записано (запуск с --apply запишет).")
