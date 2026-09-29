"""Погонаж делается полностью на Фабрике (ответ пользователя 29.09): все
этапы маршрута позиций группы «Погонаж» — на участок «Фабрика».

    .venv\\Scripts\\python scripts\\fix_trim_route.py           — показать, что будет
    .venv\\Scripts\\python scripts\\fix_trim_route.py --apply   — записать

Не трогает этапы, на которых стоят партии (их нет — проверяется).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from app.db.session import SessionLocal  # noqa: E402
from app.models.areas import Area  # noqa: E402
from app.models.items import Item, ItemGroup, ItemKind  # noqa: E402
from app.models.part_units import PartUnit  # noqa: E402

FACTORY = "fabrika"
GROUP = "Погонаж"


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        if db.get(Area, FACTORY) is None and not db.query(Area).filter(Area.code == FACTORY).first():
            print(f"Нет участка {FACTORY}")
            sys.exit(1)
        pf = db.query(ItemKind).filter(ItemKind.code == "pf").one()
        group = db.query(ItemGroup).filter(ItemGroup.name == GROUP, ItemGroup.kind_id == pf.id).first()
        if group is None:
            print(f"Нет группы «{GROUP}»")
            sys.exit(1)
        items = db.query(Item).filter(Item.group_id == group.id).order_by(Item.name).all()
        changed = 0
        for item in items:
            stages = sorted(item.stages, key=lambda s: s.sequence_order)
            if not stages:
                print(f"  {item.name}: маршрута нет — пропуск")
                continue
            moves = [s for s in stages if s.area != FACTORY]
            busy = [s for s in moves if db.query(PartUnit.id).filter(PartUnit.stage_id == s.id).first()]
            if busy:
                print(f"  {item.name}: на этапах {[s.name for s in busy]} есть партии — пропуск")
                continue
            if moves:
                print(f"  {item.name}: " + ", ".join(f"{s.name} {s.area} → {FACTORY}" for s in moves))
                for s in moves:
                    s.area = FACTORY
                changed += len(moves)
        print(f"Этапов к переносу: {changed}")
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
