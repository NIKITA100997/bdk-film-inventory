"""Производитель МДФ — единообразно везде (пожелание пользователя 13.10.2026).

Было: «Kastamonu» в названии только у Kastamonu, Беларусь — без
производителя; на печати «Каст.»/«Бел.». Стало: где у позиции известен
производитель МДФ — он полностью и всегда на одном месте:
  • Заготовка МДФ 6х610х2010 Kastamonu / … Беларусь
  • В-10 Панель щитовой двери 6х610х2010 (фрезерованная, Беларусь)
  • Панель щитовой двери 6х610х2010 (ПЭТ Бежевый, Kastamonu)
  • материалы: МДФ 6 мм Беларусь, МДФ 8 мм Беларусь (рядом с … Kastamonu)
Старые названия — синонимы позиций (тексты нарядов и 1С узнаются как раньше).

    .venv\\Scripts\\python scripts\\shield_mdf_names_1014.py           — показать
    .venv\\Scripts\\python scripts\\shield_mdf_names_1014.py --apply   — записать
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from sqlalchemy import func  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.models.dictionaries import Part  # noqa: E402
from app.models.items import Item, ItemKind, ItemType  # noqa: E402
from app.services import type_rules  # noqa: E402
from app.services.item_aliases import add_alias  # noqa: E402

TEMPLATES = {
    "Заготовка МДФ": 'Заготовка МДФ {толщина}х{ширина}х{высота}{" " + мдф if мдф else ""}',
    "Панель щитовая фрезерованная": '{серия} Панель щитовой двери {толщина}х{ширина}х{высота} (фрезерованная{", " + мдф if мдф else ""})',
    "Панель щитовая ламинированная": 'Панель щитовой двери {толщина}х{ширина}х{высота} ({цвет}{", " + мдф if мдф else ""})',
}
MATERIALS = {"МДФ 6 мм": "МДФ 6 мм Беларусь", "МДФ 8 мм": "МДФ 8 мм Беларусь"}


def rename(db, it: Item, new: str, stats: dict) -> None:
    if not new or new == it.name:
        return
    other = db.query(Item).filter(func.lower(Item.name) == new.lower(), Item.id != it.id).first()
    if other is not None:
        print(f"  совпадение — не переименовываю: «{it.name}» → «{new}» (уже есть №{other.id})")
        stats["clash"] += 1
        return
    old = it.name
    for p in db.query(Part).filter(Part.item_id == it.id):
        p.name = new
    it.name = new
    db.flush()
    try:
        add_alias(db, it, old, source="переименование МДФ 13.10")
    except ValueError:
        pass
    stats["renamed"] += 1
    if stats["renamed"] <= 12:
        print(f"  «{old}» → «{new}»")


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    stats = {"renamed": 0, "clash": 0}
    try:
        for tname, tpl in TEMPLATES.items():
            t = db.query(ItemType).filter(ItemType.name == tname).first()
            if t is None:
                print(f"Нет типа «{tname}»")
                continue
            if t.name_template != tpl:
                print(f"Шаблон «{tname}»: {t.name_template} → {tpl}")
                t.name_template = tpl
            db.flush()
            for it in db.query(Item).filter(Item.type_id == t.id, Item.is_model.is_(False)):
                res = type_rules.compute(db, t, type_rules.context_from_values(db, t, type_rules.item_values(db, it)))
                if not res.errors:
                    rename(db, it, res.name, stats)
        mat = db.query(ItemKind).filter(ItemKind.code == "material").one()
        for old, new in MATERIALS.items():
            it = db.query(Item).filter(Item.kind_id == mat.id, Item.name == old).first()
            if it is not None:
                rename(db, it, new, stats)
        print(f"Переименовано {stats['renamed']}, совпадений {stats['clash']}")
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
