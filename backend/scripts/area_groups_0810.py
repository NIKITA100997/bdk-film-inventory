"""Щитовые участки (08.10.2026, ответы пользователя):

1. Признаки объединения строк заданий: склейка — серия, размер, цвет;
   фрезеровка периметра — серия, размер, цвет; сборка — серия, размер,
   цвет, позиция целиком; кромка — вид и цвет кромки, размер, серия, цвет
   двери; фрезеровка под замок — серия, замок, размер, цвет; упаковка —
   позиция целиком.
2. «черная ABS» и «черная ABS 2мм» — одна кромка: у позиций приводится к
   «черная ABS 2мм», в шаблон импорта графика — правило на будущее.
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
    "frezerovka_perimetra_shchitov": ["серия", "ширина", "высота", "цвет"],
    "sborka_shchitovykh_dverey": ["серия", "ширина", "высота", "цвет", "позиция"],
    "kromka_shchitovykh_dverey": ["кромка", "цвет_кромки", "ширина", "высота", "серия", "цвет"],
    "frezerovka_pod_zamok": ["серия", "замок", "ширина", "высота", "цвет"],
    "upakovka_shchitovykh_dverey": ["позиция"],
}
SHIELD_TYPE = "Щитовая дверь"
EDGE_FROM, EDGE_TO = "черная ABS", "черная ABS 2мм"
EDGE_RULE = {"code": "цвет_кромки", "source": "цвет_кромки", "pattern": "^черная abs$", "value": EDGE_TO}


def normalize_edge(db) -> None:
    from app.models.items import ItemProperty, ItemPropertyValue, ItemType

    t = db.query(ItemType).filter(ItemType.name == SHIELD_TYPE).first()
    if t is None:
        print("  типа «Щитовая дверь» нет — пропуск")
        return
    prop = db.query(ItemProperty).filter(ItemProperty.type_id == t.id, ItemProperty.code == "цвет_кромки").first()
    if prop is None:
        print("  свойства «цвет_кромки» нет — пропуск")
        return
    vals = db.query(ItemPropertyValue).filter(ItemPropertyValue.property_id == prop.id, ItemPropertyValue.value_text == EDGE_FROM).all()
    for v in vals:
        v.value_text = EDGE_TO
    print(f"  кромка «{EDGE_FROM}» → «{EDGE_TO}»: позиций {len(vals)}")
    tpl = dict(t.import_template or {})
    rules = list(tpl.get("rules") or [])
    if EDGE_RULE not in rules:
        # сразу после правила, которое достаёт цвет кромки из наименования
        at = next((i + 1 for i, r in enumerate(rules) if r.get("code") == "цвет_кромки" and "source" not in r), 0)
        rules.insert(at, EDGE_RULE)
        tpl["rules"] = rules
        t.import_template = tpl
        print("  шаблон импорта: правило «черная ABS» → «черная ABS 2мм» добавлено")


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
        normalize_edge(db)
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
