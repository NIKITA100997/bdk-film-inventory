"""Признаки объединения строк для участков щитовых дверей (08.10.2026).

Предложение — уточняется с пользователем: склейка — серия, размер, цвет;
фрезеровка периметра — серия и размер; сборка — плюс стекло и молдинг;
кромка — вид и цвет кромки, размер; фрезеровка под замок — серия и замок;
упаковка — позиция целиком (одинаковые двери из разных счетов).
Без --apply только показывает.

    .venv\\Scripts\\python scripts\\area_groups_0810.py [--apply]
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from app.db.session import SessionLocal  # noqa: E402
from app.models.areas import Area  # noqa: E402

GROUPS = {
    "skleyka_shchitov": ["серия", "ширина", "высота", "цвет"],
    "frezerovka_perimetra_shchitov": ["серия", "ширина", "высота"],
    "sborka_shchitovykh_dverey": ["серия", "ширина", "высота", "цвет", "стекло", "молдинг"],
    "kromka_shchitovykh_dverey": ["кромка", "цвет_кромки", "ширина", "высота"],
    "frezerovka_pod_zamok": ["серия", "замок"],
    "upakovka_shchitovykh_dverey": ["позиция"],
}


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        for code, props in GROUPS.items():
            a = db.get(Area, code)
            if a is None:
                print(f"  участка {code} нет — пропуск")
                continue
            print(f"  «{a.name}»: {a.group_props or '—'} → {props}")
            a.group_props = props
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
