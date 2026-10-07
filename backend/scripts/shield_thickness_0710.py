"""Толщины щитовых и названия каркасов (ответы пользователя 07.10.2026).

  • Каркас А-10 — 21,5 мм (было 22); пенопласт = каркас − 1: А-10 — 20,5 мм.
    Позиция «Пенопласт 20.5 мм» заводится по образцу «Пенопласт 21.5 мм».
  • Название каркаса — толщина первой: «Каркас 24х810х2010» (было
    «Каркас 810х2010х24»). Существующие каркасы переименовываются вместе с
    деталью п/ф — партии и задания сохраняются.
  • Пересчёт техкарт каркасов и дверей.

    .venv\\Scripts\\python scripts\\shield_thickness_0710.py           — показать
    .venv\\Scripts\\python scripts\\shield_thickness_0710.py --apply   — записать
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from sqlalchemy import func  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.models.dictionaries import Part  # noqa: E402
from app.models.items import Item, ItemType  # noqa: E402
from app.services import type_rules  # noqa: E402

FRAME_TEMPLATE = "Каркас {толщина}х{ширина}х{высота}"
SERIES_FRAME = {"А-10": 21.5}
FOAM_NEW, FOAM_SAMPLE = "Пенопласт 20.5 мм", "Пенопласт 21.5 мм"


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        door = db.query(ItemType).filter(ItemType.name == "Щитовая дверь").one()
        frame = db.query(ItemType).filter(ItemType.name == "Каркас щитовой двери").one()

        series = next(p for p in door.properties if p.id == door.model_property_id)
        for o in series.options:
            if o.value in SERIES_FRAME:
                old = (o.params or {}).get("толщина_каркаса")
                if old != SERIES_FRAME[o.value]:
                    o.params = {**(o.params or {}), "толщина_каркаса": SERIES_FRAME[o.value]}
                    print(f"Серия {o.value}: каркас {old} → {SERIES_FRAME[o.value]} мм")

        if db.query(Item).filter(func.lower(Item.name) == FOAM_NEW.lower()).first() is None:
            sample = db.query(Item).filter(Item.name == FOAM_SAMPLE).first()
            if sample is None:
                print(f"Нет образца «{FOAM_SAMPLE}» — «{FOAM_NEW}» не заведён")
            else:
                db.add(Item(kind_id=sample.kind_id, name=FOAM_NEW, unit=sample.unit, group_id=sample.group_id,
                            type_id=sample.type_id, is_active=True))
                print(f"Новая позиция «{FOAM_NEW}»")

        if frame.name_template != FRAME_TEMPLATE:
            print(f"Шаблон каркаса: «{frame.name_template}» → «{FRAME_TEMPLATE}»")
            frame.name_template = FRAME_TEMPLATE
        db.flush()

        renamed = clash = 0
        for it in db.query(Item).filter(Item.type_id == frame.id, Item.is_model.is_(False)).all():
            res = type_rules.compute(db, frame, type_rules.context_from_values(db, frame, type_rules.item_values(db, it)))
            if res.errors or not res.name or res.name == it.name:
                continue
            other = db.query(Item).filter(func.lower(Item.name) == res.name.lower(), Item.id != it.id).first()
            if other is not None:
                print(f"  {it.name}: «{res.name}» уже есть — не переименовываю")
                clash += 1
                continue
            for p in db.query(Part).filter(Part.item_id == it.id):
                p.name = res.name
            it.name = res.name
            renamed += 1
        db.flush()
        print(f"Каркасов переименовано: {renamed}, совпадений: {clash}")

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
            print(f"{t.name}: техкарт пересчитано {ok}, ошибок {len(bad)}", list(bad.items())[:3])

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
