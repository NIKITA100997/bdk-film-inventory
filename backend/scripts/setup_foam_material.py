"""Пенопласт щитовых — материал в м², а не нарезанные куски-п/ф (решение
пользователя 28.09.2026).

  • материалы «Пенопласт N мм» (N = толщина каркаса серии − 1), ед. м²;
  • правила состава «Щитовой двери»: вместо трёх кусков «Пенопласт
    Nх200х(высота−100)» и т.п. — тот же материал, количество = площадь
    кусков по той же таблице ширин (шт × ширина × длина / 1 000 000);
  • техкарты дверей типа пересчитываются по правилам;
  • прежние куски «Пенопласт …х…х…» (п/ф без партий) — в архив.

Повторяемо. Запуск из backend/:
    .venv/Scripts/python.exe scripts/setup_foam_material.py          # проверка
    .venv/Scripts/python.exe scripts/setup_foam_material.py --apply  # записать"""

import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, ".")

from sqlalchemy import func  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.models.dictionaries import Part  # noqa: E402
from app.models.items import Item, ItemKind, ItemType, ItemTypeComponent  # noqa: E402
from app.models.part_units import PartUnit  # noqa: E402
from app.services import type_rules  # noqa: E402

TYPE_NAME = "Щитовая дверь"
FOAM_NAME = "Пенопласт {серия.толщина_каркаса - 1} мм"
# (шт по ширине двери, ширина куска, мм) — прежняя таблица кусков
PIECES = [
    ("(2 if ширина in (600, 900, 1000) else 0)", 200),
    ("(3 if ширина == 700 else (2 if ширина == 800 else 0))", 150),
    ("(1 if ширина >= 800 else 0)", 250),
]

apply = "--apply" in sys.argv
db = SessionLocal()
t = db.query(ItemType).filter(ItemType.name == TYPE_NAME).one()
material_kind = db.query(ItemKind).filter(ItemKind.code == "material").one()
series = next(p for p in t.properties if p.id == t.model_property_id)

# --- материалы ---
thicknesses = sorted({float(o.params["толщина_каркаса"]) - 1 for o in series.options if o.params.get("толщина_каркаса")})
for th in thicknesses:
    name = f"Пенопласт {th:g} мм"
    if db.query(Item.id).filter(Item.kind_id == material_kind.id, func.lower(Item.name) == name.lower()).first():
        continue
    db.add(Item(kind_id=material_kind.id, name=name, unit="м²"))
    print(f"  материал: {name}")
db.flush()

# --- правила состава ---
foam_rules = [r for r in t.component_rules if r.name_template.startswith("Пенопласт")]
if all(r.name_template == FOAM_NAME for r in foam_rules):
    print("Правила пенопласта уже в м² — не меняю")
else:
    for r in foam_rules:
        db.delete(r)
    db.flush()
    base = max((r.sort_order for r in t.component_rules), default=0)
    for i, (pieces, width) in enumerate(PIECES, start=1):
        t.component_rules.append(
            ItemTypeComponent(
                sort_order=base + i, name_template=FOAM_NAME,
                qty_expr=f"{pieces} * {width} * (высота - 100) / 1000000", operation_name="Склейка щитов",
            )
        )
        print(f"  правило: {FOAM_NAME} × {pieces} × {width} × (высота − 100) мм²")
    db.flush()
    db.refresh(t)

# --- пересчёт техкарт дверей ---
ok, bad = 0, 0
for item in db.query(Item).filter(Item.type_id == t.id, Item.is_model.is_(False)).order_by(Item.name):
    sp = db.begin_nested()
    res = type_rules.apply(db, item)
    if res.errors:
        sp.rollback()
        bad += 1
        print(f"  ошибка: {item.name}: {res.errors[0]}")
    else:
        sp.commit()
        ok += 1
print(f"Техкарт пересчитано: {ok}, с ошибками: {bad}")

# --- прежние куски в архив ---
for p in db.query(Part).filter(Part.name.like("Пенопласт %х%х%"), Part.is_active.is_(True)):
    if db.query(PartUnit.id).filter(PartUnit.part_id == p.id).first():
        print(f"  не трогаю (есть партии): {p.name}")
        continue
    p.is_active = False
    item = db.get(Item, p.item_id) if p.item_id else None
    if item is not None:
        item.is_active = False
    print(f"  в архив: {p.name}")

if apply:
    db.commit()
    print("Записано.")
else:
    db.rollback()
    print("Проверка — ничего не записано (запуск с --apply запишет).")
