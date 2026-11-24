"""Слияние исторических дублей щитовых дверей (24.11).

После переноса цвета кромки и типа стекла в исполнение строки (26.10),
старые позиции с кромкой в названии заменяются на чистые нормализованные позиции,
а их прежние названия сохраняются как синонимы (ItemAlias).
"""

from app.db.session import SessionLocal
from app.models.items import Item, ItemType
from app.services import type_rules
from app.services.item_merge import merge_items

def run():
    db = SessionLocal()
    shield_type = db.get(ItemType, 12)
    if not shield_type:
        print("Тип 'Щитовая дверь' (ID 12) не найден")
        return

    targets = [
        {"group": "Group 1: В-10 600х2000 ПЭТ Бежевый молдинг", "src_ids": [861], "dst_id": 3073},
        {"group": "Group 3: А-1 800х2000 Полипропилен Манхэттен замок+стекло", "src_ids": [1221], "dst_id": 3072},
        {"group": "Group 2: В-5 800х2000 ПЭТ Бежевый", "src_ids": [794, 810], "ensure": {
            "серия": "В-5", "ширина": 800.0, "высота": 2000.0, "цвет": "ПЭТ Бежевый", "кромка": "abs"
        }},
        {"group": "Group 4: В-5 600х2000 ПЭТ Белый", "src_ids": [811, 1315], "ensure": {
            "серия": "В-5", "ширина": 600.0, "высота": 2000.0, "цвет": "ПЭТ Белый", "кромка": "abs"
        }},
        {"group": "Group 5: В-19 800х2000 ПЭТ Бежевый молдинг", "src_ids": [1237, 1338], "ensure": {
            "серия": "В-19", "ширина": 800.0, "высота": 2000.0, "цвет": "ПЭТ Бежевый", "кромка": "abs", "молдинг": True
        }},
    ]

    total_merged = 0
    props_by_code = {p.code: p for p in shield_type.properties}

    for t in targets:
        print(f"\nОбработка {t['group']}:")
        if "dst_id" in t:
            dst = db.get(Item, t["dst_id"])
        else:
            vals = {}
            for k, v in t["ensure"].items():
                p = props_by_code[k]
                if p.value_type == "list":
                    opt = next((o for o in p.options if o.value == v), None)
                    if not opt:
                        raise ValueError(f"Option '{v}' not found for property '{k}'")
                    vals[p.id] = opt.id
                elif p.value_type == "bool":
                    vals[p.id] = bool(v)
                elif p.value_type == "number":
                    vals[p.id] = float(v)
                else:
                    vals[p.id] = v
            dst, created, errors = type_rules.ensure_item(db, shield_type, vals)
            if errors:
                raise ValueError(f"ensure_item failed: {errors}")
            print(f"  Целевая чистая позиция ID {dst.id}: '{dst.name}' (создана: {created})")

        for src_id in t["src_ids"]:
            src = db.get(Item, src_id)
            if not src:
                print(f"  Позиция ID {src_id} уже не существует")
                continue
            if "[ДУБЛЬ]" in src.name or not src.is_active:
                print(f"  Позиция ID {src.id} уже архивирована")
                continue
            print(f"  Слияние ID {src.id} ('{src.name}') в ID {dst.id} ('{dst.name}')...")
            rep = merge_items(db, src, dst, user_id=1)
            print(f"    -> Успешно! Перенесено: {dict(rep.moved)}")
            total_merged += 1

    db.commit()
    print(f"\nГотово! Всего слито позиций: {total_merged}")

if __name__ == "__main__":
    run()
