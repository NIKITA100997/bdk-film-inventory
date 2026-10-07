"""Маршрут панелей щитовых (ответы пользователя 07.10.2026).

  • Под стекло фрезеруется — панель двери со стеклом идёт через фрезеровку,
    как с молдингом (раньше — только при молдинге).
  • ПЭТ фрезеруется после ламинации (Фабрика), КРОМЕ под зеркало и молдинг
    М9 — те всегда до ламинации (Северный), независимо от плёнки.
    Новый признак двери «Фрезеровка до ламинации» — из наименования графика:
    «(м9 …», «молдинг 9», «стекло Зеркало …». У уже заведённых дверей
    признак ставится по их названию.
  • Пересчёт техкарт дверей.

    .venv\\Scripts\\python scripts\\shield_panel_route_0710.py           — показать
    .venv\\Scripts\\python scripts\\shield_panel_route_0710.py --apply   — записать
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from app.db.session import SessionLocal  # noqa: E402
from app.models.items import Item, ItemProperty, ItemPropertyValue, ItemType, ItemTypeComponent  # noqa: E402
from app.services import type_rules  # noqa: E402

CODE, NAME = "до_ламинации", "Фрезеровка до ламинации (зеркало, молдинг М9)"
PATTERN = r"\(м\s*9|молдинг\s*9|стекло\s+зеркал"
PET = '("ПЭТ" in цвет or "пэт" in цвет) and not ' + CODE


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        door = db.query(ItemType).filter(ItemType.name == "Щитовая дверь").one()
        prop = next((p for p in door.properties if p.code == CODE), None)
        if prop is None:
            prop = ItemProperty(type_id=door.id, code=CODE, name=NAME, value_type="bool", is_required=False,
                                sort_order=max((p.sort_order for p in door.properties), default=0) + 1, option_fields=[])
            db.add(prop)
            db.flush()
            db.expire(door)  # свойства типа — заново, с новым признаком
            print(f"Новый признак двери «{NAME}»")

        tpl = dict(door.import_template or {})
        rules = list(tpl.get("rules") or [])
        if not any(r.get("code") == CODE for r in rules):
            rules.append({"code": CODE, "pattern": PATTERN})
            tpl["rules"] = rules
            door.import_template = tpl
            print(f"Шаблон импорта графика: признак «{CODE}» по «{PATTERN}»")

        for r in db.query(ItemTypeComponent).filter(ItemTypeComponent.type_id == door.id):
            cv = dict(r.component_values or {})
            if r.condition == "молдинг":
                r.condition = "молдинг or стекло"
                print("Панель с узором: условие «молдинг» → «молдинг or стекло» (под стекло фрезеруется)")
            elif r.condition == "not молдинг":
                r.condition = "not молдинг and not стекло"
                print("Гладкая панель: условие → «not молдинг and not стекло»")
            if "пэт" in cv and cv["пэт"] != PET:
                cv["пэт"] = PET
                r.component_values = cv
                print(f"Панель с узором: ПЭТ после ламинации, кроме «{CODE}»")
        db.flush()

        marked = 0
        for it in db.query(Item).filter(Item.type_id == door.id, Item.is_model.is_(False)):
            flag = bool(re.search(PATTERN, it.name, re.I))
            v = db.get(ItemPropertyValue, (it.id, prop.id))
            if v is None:
                db.add(ItemPropertyValue(item_id=it.id, property_id=prop.id, value_bool=flag))
            else:
                v.value_bool = flag
            marked += flag
        db.flush()
        print(f"Дверей с признаком «{CODE}»: {marked}")

        ok, bad = 0, {}
        for it in db.query(Item).filter(Item.type_id == door.id, Item.is_model.is_(False)):
            sp = db.begin_nested()
            r = type_rules.apply(db, it)
            if r.errors:
                sp.rollback()
                bad[it.name] = r.errors
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
