"""Правила щитовых по сверке с Excel (02.10). Без аргумента — проверка
(откат), apply — записать.

  • «Сборка» — только у дверей, где есть что собирать: молдинг, стекло или
    алюминиевая кромка (гладкие В-5, В-5/Ф3, В-5/Ф4 идут сразу на кромку;
    сверено с запуском 18.08 — 745 из 746 дверей, расхождение — ошибка Excel).
  • Усилитель каркаса: у каркаса 310 мм (дверь 300) его нет (запуск 16.09).
Затем пересчёт техкарт каркасов и дверей.
"""
import sys

sys.path.insert(0, ".")
import app.models  # noqa: E402,F401

from app.db.session import SessionLocal  # noqa: E402
from app.models.items import Item, ItemType, ItemTypeComponent, ItemTypeOperation  # noqa: E402
from app.services import type_rules  # noqa: E402

ASSEMBLY = 'молдинг or стекло or кромка == "aluminum"'
REINFORCER = "0 if ширина <= 310 else (1 if ширина <= 610 else 2)"

db = SessionLocal()
try:
    door = db.query(ItemType).filter(ItemType.name == "Щитовая дверь").one()
    frame = db.query(ItemType).filter(ItemType.name == "Каркас щитовой двери").one()
    op = db.query(ItemTypeOperation).filter(ItemTypeOperation.type_id == door.id, ItemTypeOperation.name == "Сборка").one()
    print(f"Сборка: условие «{op.condition}» → «{ASSEMBLY}»")
    op.condition = ASSEMBLY
    rule = (
        db.query(ItemTypeComponent)
        .filter(ItemTypeComponent.type_id == frame.id, ItemTypeComponent.name_template.like("Усилитель каркаса%"))
        .one()
    )
    print(f"Усилитель: «{rule.qty_expr}» → «{REINFORCER}»")
    rule.qty_expr = REINFORCER
    db.flush()
    for t in (frame, door):
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
        print(f"{t.name}: пересчитано {ok}, ошибок {len(bad)}", list(bad.items())[:3])
    if "apply" in sys.argv:
        db.commit()
        print("ЗАПИСАНО")
    else:
        db.rollback()
        print("проверка — откат")
finally:
    db.close()
