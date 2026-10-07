"""Пенопласт щитовых для нестандартной ширины (ответ пользователя 07.10.2026):
раскладка полос берётся по ближайшему большему стандарту — 630 → как 700,
820 → как 900; уже 600 (300, 400, 550) — как 600 (ответ 07.10).
Запас «+10 полос» из Excel больше не нужен — он и покрывал нестандарт.

    .venv\\Scripts\\python scripts\\shield_foam_std_0710.py           — показать
    .venv\\Scripts\\python scripts\\shield_foam_std_0710.py --apply   — записать
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from app.db.session import SessionLocal  # noqa: E402
from app.models.items import Item, ItemType, ItemTypeComponent  # noqa: E402
from app.services import type_rules  # noqa: E402

# ширина → количество полос по ближайшему большему стандарту (600/700/800/900/1000)
QTY = {
    200: "(2 if ширина <= 600 or 800 < ширина <= 1000 else 0)",
    150: "(3 if 600 < ширина <= 700 else (2 if 700 < ширина <= 800 else 0))",
    250: "(1 if ширина > 700 else 0)",
}


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        door = db.query(ItemType).filter(ItemType.name == "Щитовая дверь").one()
        for r in db.query(ItemTypeComponent).filter(ItemTypeComponent.type_id == door.id, ItemTypeComponent.name_template.like("Пенопласт%")):
            w = next((k for k in QTY if f"* {k} *" in (r.qty_expr or "")), None)
            if w is None or (r.qty_expr or "").startswith(QTY[w]):
                continue
            new = f"{QTY[w]} * {w} * (высота - 100) / 1000000"
            print(f"  полоса {w} мм: «{r.qty_expr}» → «{new}»")
            r.qty_expr = new
        db.flush()
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
