"""Цвет двери = плёнка: привести варианты «Цвет» типа «Щитовая дверь» к справочнику плёнок
и пересчитать техкарты дверей. Без аргумента — проверка (откат), apply — записать."""
import sys
sys.path.insert(0, ".")
import app.models  # noqa
from app.db.session import SessionLocal
from app.models.items import Item, ItemProperty, ItemType
from app.services import type_rules
from app.services.door_colors import normalize_color_options

db = SessionLocal()
try:
    t = db.query(ItemType).filter(ItemType.name == "Щитовая дверь").one()
    prop = db.query(ItemProperty).filter(ItemProperty.type_id == t.id, ItemProperty.code == "цвет").one()
    for line in normalize_color_options(db, prop):
        print(" ", line)
    db.flush()
    before = {i.id: i.name for i in db.query(Item).filter(Item.type_id == t.id, Item.is_model.is_(False))}
    ok, bad = 0, {}
    for it in db.query(Item).filter(Item.type_id == t.id, Item.is_model.is_(False)):
        sp = db.begin_nested()
        r = type_rules.apply(db, it)
        if r.errors:
            sp.rollback(); bad[it.name] = r.errors
        else:
            sp.commit(); ok += 1
    db.flush()
    renamed = [(before[i.id], i.name) for i in db.query(Item).filter(Item.id.in_(list(before))) if i.name != before[i.id]]
    print(f"техкарт пересчитано {ok}, ошибок {len(bad)}; переименовано дверей {len(renamed)}")
    for a, b in renamed[:6]:
        print("   ", a, "→", b)
    for k, v in list(bad.items())[:5]:
        print("  ОШИБКА", k, v)
    print("варианты «Цвет» теперь:", [o.value for o in prop.options if o.is_active])
    if "apply" in sys.argv and not bad:
        db.commit(); print("ЗАПИСАНО")
    else:
        db.rollback(); print("проверка — откат")
finally:
    db.close()
