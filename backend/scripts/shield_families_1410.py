"""Щитовые двери как в 1С (решение пользователя 14.10.2026).

  • Папки: «Каркасно-щитовые» → «Серия А», «Серия В», «Серия Граффити»
    (В-28, В-34), «Серия Е», «Серия Н»; модели и их варианты — в папку
    своей серии. Царговые не трогаем.
  • Свойство «Серия» типа «Щитовая дверь» называется «Модель» (код
    «серия» прежний — шаблоны и правила не меняются).
  • Поле варианта «Синонимы» — как модель называется в 1С; импорт счёта
    узнаёт её и по синониму: «В-5 Ф-4» = В-5/Ф4, «Граффити-2» = В-28.

    .venv\\Scripts\\python scripts\\shield_families_1410.py           — показать
    .venv\\Scripts\\python scripts\\shield_families_1410.py --apply   — записать
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from sqlalchemy.orm.attributes import flag_modified  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.models.items import Item, ItemGroup, ItemKind, ItemPropertyValue, ItemType  # noqa: E402

ROOT = "Каркасно-щитовые"
FAMILIES = ["Серия А", "Серия В", "Серия Граффити", "Серия Е", "Серия Н"]
GRAFFITI = {"В-28", "В-34"}
SYNONYMS = {"В-5/Ф4": "В-5 Ф-4", "В-28": "Граффити-2; В-28 (Граффити-2)", "В-34": "Граффити-5; В-34 (Граффити-5)"}
SYN_FIELD = {"code": "синонимы", "name": "Синонимы (как в 1С, через ;)", "value_type": "text"}


def family(model_value: str) -> str | None:
    if model_value in GRAFFITI:
        return "Серия Граффити"
    first = model_value[:1].upper()
    return {"А": "Серия А", "В": "Серия В", "Е": "Серия Е", "Н": "Серия Н"}.get(first)


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        door = db.query(ItemType).filter(ItemType.name == "Щитовая дверь").one()
        prop = next(p for p in door.properties if p.id == door.model_property_id)
        kind = db.query(ItemKind).filter(ItemKind.code == "izdelie").one()

        if prop.name != "Модель":
            print(f"Свойство «{prop.name}» → «Модель» (код «{prop.code}» прежний)")
            prop.name = "Модель"
        if not any(f.get("code") == SYN_FIELD["code"] for f in (prop.option_fields or [])):
            prop.option_fields = [*(prop.option_fields or []), SYN_FIELD]
            flag_modified(prop, "option_fields")
            print("Поле варианта «Синонимы» добавлено")
        for o in prop.options:
            want = SYNONYMS.get(o.value)
            if want and (o.params or {}).get("синонимы") != want:
                o.params = {**(o.params or {}), "синонимы": want}
                flag_modified(o, "params")
                print(f"Синонимы {o.value}: {want}")

        def group(name: str, parent: int | None, order: int) -> ItemGroup:
            g = db.query(ItemGroup).filter(ItemGroup.kind_id == kind.id, ItemGroup.name == name, ItemGroup.parent_id == parent).first()
            if g is None:
                g = ItemGroup(kind_id=kind.id, name=name, parent_id=parent, sort_order=order)
                db.add(g)
                db.flush()
                print(f"Папка «{name}»")
            return g

        root = group(ROOT, None, 0)
        groups = {n: group(n, root.id, i) for i, n in enumerate(FAMILIES, start=1)}

        moved = 0
        for m in db.query(Item).filter(Item.type_id == door.id, Item.is_model.is_(True)):
            v = db.query(ItemPropertyValue).filter(ItemPropertyValue.item_id == m.id, ItemPropertyValue.property_id == prop.id).first()
            opt = next((o for o in prop.options if v and o.id == v.option_id), None)
            fam = family(opt.value) if opt else None
            if fam is None:
                print(f"  {m.name}: серия не определилась — без папки")
                continue
            gid = groups[fam].id
            for it in [m, *db.query(Item).filter(Item.model_id == m.id)]:
                if it.group_id != gid:
                    it.group_id = gid
                    moved += 1
        db.flush()
        for n, g in groups.items():
            cnt = db.query(Item).filter(Item.group_id == g.id).count()
            print(f"  {n}: позиций {cnt}")
        print(f"Перенесено в папки: {moved}")
        if apply:
            db.commit()
            print("Записано.")
        else:
            db.rollback()
            print("Пробный прогон — ничего не записано (--apply — записать).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
