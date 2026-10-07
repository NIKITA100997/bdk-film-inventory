"""МДФ панелей щитовых (ответ пользователя 07.10.2026): под ПЭТ — Kastamonu
(не шлифуется), под остальные плёнки — Беларусь.

  • Признак «мдф» у заготовки, ламинированной и фрезерованной панели;
    передаётся по цепочке от цвета двери: ПЭТ → Kastamonu, иначе Беларусь.
  • Заготовка МДФ списывает МДФ по площади на распиле: «МДФ {т} мм»
    (Беларусь) или «МДФ {т} мм Kastamonu» (новые позиции 6 и 8 мм).
  • Шлифовка у Kastamonu не делается: операция с условием, заготовка
    расходуется на следующей операции (ламинация / фрезеровка).
  • Названия Беларусь не меняются; у Kastamonu — с пометкой.
  • Пересчёт техкарт панелей и дверей.

    .venv\\Scripts\\python scripts\\shield_mdf_0710.py           — показать
    .venv\\Scripts\\python scripts\\shield_mdf_0710.py --apply   — записать
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from sqlalchemy import func  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.models.items import Item, ItemProperty, ItemPropertyValue, ItemType, ItemTypeComponent, ItemTypeOperation  # noqa: E402
from app.services import type_rules  # noqa: E402

K, B = "Kastamonu", "Беларусь"
CODE = "мдф"
BY_COLOR = f'"{K}" if "ПЭТ" in цвет or "пэт" in цвет else "{B}"'
NOT_K = f'мдф != "{K}"'
IS_K = f'мдф == "{K}"'
TEMPLATES = {
    "Заготовка МДФ": 'Заготовка МДФ {толщина}х{ширина}х{высота}{" Kastamonu" if мдф == "Kastamonu" else ""}',
    "Панель щитовая фрезерованная": '{серия} Панель щитовой двери {толщина}х{ширина}х{высота} (фрезерованная{", Kastamonu" if мдф == "Kastamonu" else ""})',
}
NEW_MATERIALS = ["МДФ 6 мм Kastamonu", "МДФ 8 мм Kastamonu"]


def T(db, name):
    return db.query(ItemType).filter(ItemType.name == name).one()


def ensure_prop(db, t: ItemType) -> ItemProperty:
    p = next((x for x in t.properties if x.code == CODE), None)
    if p is None:
        p = ItemProperty(type_id=t.id, code=CODE, name="МДФ (производитель)", value_type="text", is_required=False,
                         sort_order=max((x.sort_order for x in t.properties), default=0) + 1, option_fields=[])
        db.add(p)
        db.flush()
        db.expire(t)
        print(f"  «{t.name}»: признак «{CODE}»")
    return p


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        raw, lam, mil, pat, door = (T(db, n) for n in ("Заготовка МДФ", "Панель щитовая ламинированная",
                                                        "Панель щитовая фрезерованная", "Панель щитовая с узором", "Щитовая дверь"))
        props = {t.id: ensure_prop(db, t) for t in (raw, lam, mil)}

        sample = db.query(Item).filter(Item.name == "МДФ 6 мм").first()
        for name in NEW_MATERIALS:
            if sample and db.query(Item).filter(func.lower(Item.name) == name.lower()).first() is None:
                db.add(Item(kind_id=sample.kind_id, name=name, unit=sample.unit, group_id=sample.group_id, type_id=sample.type_id, is_active=True))
                print(f"  новая позиция «{name}»")

        for t in (raw, mil):
            if t.name_template != TEMPLATES[t.name]:
                t.name_template = TEMPLATES[t.name]
                print(f"  шаблон «{t.name}»: {t.name_template}")

        # заготовка: МДФ по площади на распиле
        if not db.query(ItemTypeComponent).filter(ItemTypeComponent.type_id == raw.id, ItemTypeComponent.name_template.like("МДФ%")).first():
            db.add(ItemTypeComponent(
                type_id=raw.id, name_template='МДФ {толщина} мм{" Kastamonu" if мдф == "Kastamonu" else ""}',
                qty_expr="ширина * высота / 1000000", operation_name="Распил", sort_order=0,
            ))
            print("  заготовка: списание МДФ по площади на распиле")

        # шлифовка — только не Kastamonu; заготовка — на шлифовке или на следующей операции
        for t, nxt in ((lam, "Ламинация"), (mil, "Фрезеровка")):
            op = db.query(ItemTypeOperation).filter(ItemTypeOperation.type_id == t.id, ItemTypeOperation.name == "Шлифовка").first()
            if op is not None and op.condition != NOT_K:
                op.condition = NOT_K
                print(f"  «{t.name}»: шлифовка только не Kastamonu")
            rules = db.query(ItemTypeComponent).filter(ItemTypeComponent.type_id == t.id, ItemTypeComponent.component_type_id == raw.id).all()
            for r in rules:
                cv = dict(r.component_values or {})
                if cv.get(CODE) != CODE:
                    cv[CODE] = CODE
                    r.component_values = cv
            if t is lam and len(rules) == 1:
                r = rules[0]
                r.condition = NOT_K
                db.add(ItemTypeComponent(type_id=t.id, name_template="", qty_expr=r.qty_expr, condition=IS_K, operation_name=nxt,
                                         component_type_id=raw.id, component_values=dict(r.component_values),
                                         width_expr=r.width_expr, length_expr=r.length_expr, sort_order=r.sort_order))
                print(f"  «{t.name}»: Kastamonu — заготовка расходуется на «{nxt}»")

        # мдф по цепочке от цвета двери
        for r in db.query(ItemTypeComponent).filter(ItemTypeComponent.type_id.in_([door.id, pat.id])):
            if r.component_type_id in (lam.id, mil.id):
                cv = dict(r.component_values or {})
                want = f'"{K}"' if (r.type_id == pat.id and r.component_type_id == lam.id) else BY_COLOR
                if cv.get(CODE) != want:
                    cv[CODE] = want
                    r.component_values = cv
                    print(f"  правило {db.get(ItemType, r.type_id).name} → {db.get(ItemType, r.component_type_id).name}: мдф = {want}")
        db.flush()

        # признак у уже заведённых позиций
        def setv(item_id, pid, value):
            v = db.get(ItemPropertyValue, (item_id, pid))
            if v is None:
                db.add(ItemPropertyValue(item_id=item_id, property_id=pid, value_text=value))
            elif not v.value_text:
                v.value_text = value

        n = 0
        for it in db.query(Item).filter(Item.type_id.in_([raw.id, lam.id, mil.id]), Item.is_model.is_(False)):
            val = K if (it.type_id == lam.id and "пэт" in it.name.lower()) else B
            setv(it.id, props[it.type_id].id, val)
            n += 1
        db.flush()
        print(f"  признак проставлен у {n} позиций")

        for t in (raw, lam, mil, pat, door):
            ok, bad = 0, {}
            for it in db.query(Item).filter(Item.type_id == t.id, Item.is_model.is_(False)):
                sp = db.begin_nested()
                res = type_rules.apply(db, it)
                if res.errors:
                    sp.rollback()
                    bad[it.name] = res.errors
                else:
                    sp.commit()
                    ok += 1
            print(f"{t.name}: техкарт {ok}, ошибок {len(bad)}", list(bad.items())[:2])

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
