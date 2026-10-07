"""Фрезеровка щитовых по площадкам (ответ пользователя 07.10.2026): всё,
что фрезеруется до ламинации, — на Северном; всё, что после ламинации, —
на Фабрике.

По маршрутам это:
- «Панель щитовая фрезерованная» — фрезеровка до ламинации → участок
  «Фрезеровка панелей» получает площадку Северный;
- «Панель щитовая с узором», ветка ПЭТ (ламинация → фрезеровка) —
  фрезеровка после ламинации → новый участок «Фрезеровка ламинированных
  панелей» на Фабрике (настройки — как у «Фрезеровки панелей»);
- «Щитовая дверь»: фрезеровка периметра и под замок — щит уже в плёнке →
  участки получают площадку Фабрика.

Этапы позиций, уже разложенные по старому участку, переносятся вместе с
операцией типа; если на этапе есть партии или задания — пропускается.

    .venv\\Scripts\\python scripts\\shield_milling_sites_0710.py           — показать
    .venv\\Scripts\\python scripts\\shield_milling_sites_0710.py --apply   — записать
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from app.db.session import SessionLocal  # noqa: E402
from app.models.areas import Area  # noqa: E402
from app.models.dictionaries import PartStage  # noqa: E402
from app.models.items import Item, ItemType, ItemTypeOperation  # noqa: E402
from app.models.part_units import PartUnit  # noqa: E402
from app.models.production import ProductionTaskLine  # noqa: E402
from app.models.sites import Site  # noqa: E402
from app.services.areas import unique_area_code  # noqa: E402

BEFORE = "frezerovka_paneley"
NEW_NAME = "Фрезеровка ламинированных панелей"
AFTER_DOOR = ("frezerovka_perimetra_shchitov", "frezerovka_pod_zamok")
PATTERNED = "Панель щитовая с узором"
COPY = ("requires_daily_plan", "lead_days", "capacity_per_shift", "shifts_per_day", "pay_mode", "piece_rate",
        "shift_rate", "shift_headcount")


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        sites = {s.name: s for s in db.query(Site)}
        north, factory = sites.get("Северный"), sites.get("Фабрика")
        if north is None or factory is None:
            print("Нет площадок «Северный» / «Фабрика»")
            sys.exit(1)
        before = db.get(Area, BEFORE)
        if before is None:
            print(f"Нет участка {BEFORE}")
            sys.exit(1)

        if before.site_id != north.id:
            print(f"«{before.name}»: площадка → Северный (фрезеровка до ламинации)")
            before.site_id = north.id
        for code in AFTER_DOOR:
            a = db.get(Area, code)
            if a is not None and a.site_id != factory.id:
                print(f"«{a.name}»: площадка → Фабрика (фрезеровка после ламинации)")
                a.site_id = factory.id

        after = db.query(Area).filter(Area.name == NEW_NAME).first()
        if after is None:
            after = Area(code=unique_area_code(db, NEW_NAME), name=NEW_NAME, is_active=True, site_id=factory.id)
            for f in COPY:
                setattr(after, f, getattr(before, f))
            db.add(after)
            db.flush()
            print(f"Новый участок «{NEW_NAME}» ({after.code}) на Фабрике")

        t = db.query(ItemType).filter(ItemType.name == PATTERNED).first()
        if t is not None:
            for op in db.query(ItemTypeOperation).filter(ItemTypeOperation.type_id == t.id, ItemTypeOperation.area == BEFORE):
                print(f"«{PATTERNED}», операция «{op.name}» ({op.condition or 'всегда'}): участок → «{NEW_NAME}»")
                op.area = after.code
            stages = (
                db.query(PartStage)
                .join(Item, Item.id == PartStage.item_id)
                .filter(Item.type_id == t.id, PartStage.area == BEFORE)
                .all()
            )
            moved = skipped = 0
            for s in stages:
                busy = db.query(PartUnit.id).filter(PartUnit.stage_id == s.id).first() or db.query(ProductionTaskLine.id).filter(
                    ProductionTaskLine.part_stage_id == s.id
                ).first()
                if busy:
                    skipped += 1
                    continue
                s.area = after.code
                moved += 1
            print(f"Этапов позиций перенесено: {moved}, пропущено (есть партии или задания): {skipped}")

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
