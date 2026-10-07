"""Серии щитовых дверей, которые есть в прайсах, но не были заведены
(сверка с прайсами Calc 07.10.2026): А-4, А-8 (прайс серии А 01.04.2026),
В-17 (В-ПЭТ 15.04.2026), Е-9, Е-11, Е-16, Е-28, Е-34 (Е-ПЭТ 15.04.2026).

Параметры — как у серий того же семейства (толщина каркаса и панели,
кромка); поправить можно в «Номенклатура → Типы → Щитовая дверь → Серии».
В-1/Ф2, В-12, В-5/Ф3, В-5/Ф4 — по словам пользователя одна модель В-5 с
разными программами фрезеровки; их не трогаем.

    .venv\\Scripts\\python scripts\\add_shield_series_0710.py           — показать
    .venv\\Scripts\\python scripts\\add_shield_series_0710.py --apply   — записать
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from app.db.session import SessionLocal  # noqa: E402
from app.models.items import ItemType  # noqa: E402
from app.services.model_builder import add_model  # noqa: E402

TYPE_NAME = "Щитовая дверь"
NEW = {"А": ["А-4", "А-8"], "В": ["В-17"], "Е": ["Е-9", "Е-11", "Е-16", "Е-28", "Е-34"]}
# образец параметров семейства
SAMPLE = {"А": "А-1", "В": "В-5", "Е": "Е-5"}


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        t = db.query(ItemType).filter(ItemType.name == TYPE_NAME).one()
        prop = next(p for p in t.properties if p.id == t.model_property_id)
        opts = {o.value: o for o in prop.options}
        for fam, names in NEW.items():
            sample = opts.get(SAMPLE[fam])
            if sample is None:
                print(f"Нет образца {SAMPLE[fam]} — семейство {fam} пропущено")
                continue
            for name in names:
                if name in opts:
                    print(f"  {name}: уже есть")
                    continue
                add_model(db, t, name, dict(sample.params or {}))
                db.flush()
                db.refresh(prop)
                opts = {o.value: o for o in prop.options}
                print(f"  {name}: заведена, параметры как у {SAMPLE[fam]}: {sample.params}")
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
