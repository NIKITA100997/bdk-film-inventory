"""В-11 и В-12 со стеклом — фрезеровка панели до ламинации (решение
пользователя 13.10.2026), даже если ПЭТ: раньше ПЭТ уходил на фрезеровку
после ламинации, кроме зеркала и молдинга М9.

  • Условие у панели с узором «ПЭТ — после ламинации» дополняется:
    не для В-11/В-12 со стеклом.
  • Пересчёт техкарт дверей (новые запуски пойдут по новому маршруту;
    уже запущенные задания не меняются).

    .venv\\Scripts\\python scripts\\shield_glass_1014.py           — показать
    .venv\\Scripts\\python scripts\\shield_glass_1014.py --apply   — записать
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from sqlalchemy.orm.attributes import flag_modified  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.models.items import Item, ItemType, ItemTypeComponent  # noqa: E402
from app.services import type_rules  # noqa: E402

GLASS = '(стекло and (серия == "В-11" or серия == "В-12"))'


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        door = db.query(ItemType).filter(ItemType.name == "Щитовая дверь").one()
        changed = 0
        for r in db.query(ItemTypeComponent).filter(ItemTypeComponent.type_id == door.id):
            cv = dict(r.component_values or {})
            pet = cv.get("пэт")
            if isinstance(pet, str) and GLASS not in pet:
                cv["пэт"] = f"{pet} and not {GLASS}"
                r.component_values = cv
                flag_modified(r, "component_values")
                changed += 1
                print(f"Правило «{r.condition}»: пэт = {cv['пэт']}")
        print(f"Правил изменено: {changed}")
        db.flush()

        hit = []
        for it in db.query(Item).filter(Item.type_id == door.id, Item.is_model.is_(False)):
            vals = type_rules.context_from_values(db, door, type_rules.item_values(db, it))
            if vals.get("стекло") and vals.get("серия") in ("В-11", "В-12"):
                hit.append(it.name)
        print(f"Дверей В-11/В-12 со стеклом: {len(hit)}", hit[:10])

        ok, bad = 0, {}
        for it in db.query(Item).filter(Item.type_id == door.id, Item.is_model.is_(False)):
            sp = db.begin_nested()
            res = type_rules.apply(db, it)
            if res.errors:
                sp.rollback()
                bad[it.name] = res.errors
            else:
                sp.commit()
                ok += 1
        print(f"Техкарт дверей пересчитано {ok}, ошибок {len(bad)}", list(bad.items())[:3])
        if apply:
            db.commit()
            print("Записано.")
        else:
            db.rollback()
            print("Проверка. Для записи добавьте --apply")
    finally:
        db.close()


if __name__ == "__main__":
    main()
