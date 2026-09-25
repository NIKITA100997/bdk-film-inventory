"""Группы номенклатуры П/ф (25.09.2026) — только данные: папки «МК»,
«Панели (металлические двери)», «Щитовые», «Погонаж» и разнесение деталей
по названию. Позиции, которым группа уже назначена (в том числе вручную), не
трогаются; не подошедшие ни под одно правило — выводятся списком.

Повторяемо. Запуск из backend/:
    .venv/Scripts/python.exe scripts/setup_item_groups.py [--dry-run]"""

import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, ".")

from app.db.session import SessionLocal  # noqa: E402
from app.models.dictionaries import Part  # noqa: E402
from app.models.items import Item, ItemGroup, ItemKind, ItemType  # noqa: E402

DRY = "--dry-run" in sys.argv
MK, PANELS, SHIELD, TRIM = "МК", "Панели (металлические двери)", "Щитовые", "Погонаж"
SHIELD_TYPES = ("Каркас щитовой двери", "Панель щитовая", "Панель щитовая ламинированная")


def classify(name: str, type_name: str | None) -> str | None:
    n = name.strip()
    low = n.lower()
    if type_name in SHIELD_TYPES or low.startswith(("заготовка для щита", "панель щитовой двери", "каркас ")):
        return SHIELD
    if "(панель)" in low or "/п" in low:
        return PANELS
    if low.startswith(("коробка", "наличник", "добор", "плинтус", "планка притворная", "планка купе", "планка не телескоп")):
        return TRIM
    if low.startswith(("стоевая", "поперечная", "порог", "планка", "филенка", "филёнка", "багет", "вставка")):
        return MK
    return None


db = SessionLocal()
kind = db.query(ItemKind).filter(ItemKind.code == "pf").one()
groups = {}
for order, name in enumerate((MK, PANELS, SHIELD, TRIM), start=1):
    g = db.query(ItemGroup).filter(ItemGroup.kind_id == kind.id, ItemGroup.parent_id.is_(None), ItemGroup.name == name).first()
    if g is None:
        g = ItemGroup(kind_id=kind.id, name=name, sort_order=order)
        db.add(g)
        db.flush()
        print("группа создана:", name)
    groups[name] = g

types = {t.id: t.name for t in db.query(ItemType)}
names = {p.item_id: p.name for p in db.query(Part) if p.item_id}
moved: dict[str, list[str]] = {k: [] for k in groups}
unmatched = []
for item in db.query(Item).filter(Item.kind_id == kind.id, Item.group_id.is_(None)):
    name = names.get(item.id, item.name)
    target = classify(name, types.get(item.type_id))
    if target is None:
        unmatched.append(name)
        continue
    item.group_id = groups[target].id
    moved[target].append(name)

for k, v in moved.items():
    print(f"{k}: {len(v)}")
print("без группы (не подошли под правила):", sorted(unmatched))
if DRY:
    db.rollback()
    print("пробный прогон — ничего не записано")
else:
    db.commit()
