"""Сопоставления плёнки, заданные пользователем 02.10, + приведение цветов
щитовых дверей к плёнке. Без аргумента — проверка (откат), apply — записать.

  Bolton Oak                                   → ПВХ Дуб болтон
  Полипропилен INVISIBLE Белый грунтовочный    → Полипропилен Инвизибол 0.18
"""
import sys

sys.path.insert(0, ".")
import app.models  # noqa: E402,F401
from sqlalchemy import func  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.models.dictionaries import Color, Material, MaterialSku, Thickness  # noqa: E402
from app.models.items import Item, ItemProperty, ItemType  # noqa: E402
from app.services import type_rules  # noqa: E402
from app.services.door_colors import normalize_color_options  # noqa: E402
from app.services.film_aliases import save_alias  # noqa: E402

PAIRS = [
    ("Bolton Oak", "ПВХ", "Дуб болтон", None),
    ("Полипропилен INVISIBLE Белый грунтовочный", "Полипропилен", "Инвизибол", 0.18),
    ("Полипропилен INVISIBLE", "Полипропилен", "Инвизибол", 0.18),
]

db = SessionLocal()
try:
    for text, mat, col, th in PAIRS:
        m = db.query(Material).filter(func.lower(Material.name) == mat.lower()).first()
        c = db.query(Color).filter(func.lower(Color.name) == col.lower(), Color.is_active.is_(True)).first()
        t = db.query(Thickness).filter(Thickness.value_mm == th).first() if th is not None else None
        if m is None or c is None or (th is not None and t is None):
            print("НЕТ В СПРАВОЧНИКЕ:", text, "→", mat, col, th)
            continue
        if th is None:
            # одна толщина у этой плёнки — её и берём
            ths = {s.thickness_id for s in db.query(MaterialSku).filter(MaterialSku.material_id == m.id, MaterialSku.color_id == c.id, MaterialSku.is_active.is_(True))}
            t = db.get(Thickness, ths.pop()) if len(ths) == 1 else None
        save_alias(db, text, m.id, c.id, t.id if t else None, source="вручную (02.10)")
        print("сопоставление:", text, "→", m.name, c.name, float(t.value_mm) if t else "любая толщина")
    t = db.query(ItemType).filter(ItemType.name == "Щитовая дверь").first()
    if t is not None:
        prop = db.query(ItemProperty).filter(ItemProperty.type_id == t.id, ItemProperty.code == "цвет").one()
        for line in normalize_color_options(db, prop):
            print(" ", line)
        from app.services.door_colors import sync_film_colors

        print("  цветов из справочника плёнок заведено:", sync_film_colors(db, prop))
        ok, bad = 0, {}
        for it in db.query(Item).filter(Item.type_id == t.id, Item.is_model.is_(False)):
            sp = db.begin_nested()
            r = type_rules.apply(db, it)
            if r.errors:
                sp.rollback()
                bad[it.name] = r.errors
            else:
                sp.commit()
                ok += 1
        print(f"техкарт дверей пересчитано {ok}, ошибок {len(bad)}", list(bad.items())[:3])
        print("цветов всего:", len([o for o in prop.options if o.is_active]))
    if "apply" in sys.argv:
        db.commit()
        print("ЗАПИСАНО")
    else:
        db.rollback()
        print("проверка — откат")
finally:
    db.close()
