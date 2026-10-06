"""Погонаж: ламинированный — готов к продаже, неламинированный — п/ф
(ответ пользователя 06.10).

Изделие погонажа (название 1С) = ламинированный погонаж: признак «деталь в
плёнке», маршрут — одна операция «Окутка» на Фабрике, в составе — п/ф того
же погонажа 1 шт, расходуется на этой окутке. Закрыли задание — изделие
приходит на склад готовой продукции. П/ф погонажа = неламинированный: его
маршрут заканчивается до окутки, остаток лежит на Фабрике.

    .venv\\Scripts\\python scripts\\setup_trim_laminated.py           — показать, что будет
    .venv\\Scripts\\python scripts\\setup_trim_laminated.py --apply   — записать

Окутку с п/ф не снимает, если на ней есть партии, строки заданий или
пересчёты, — такие позиции пропускаются с объяснением. Изделия без пары-п/ф
только перечисляются: пару выбирают вручную (Номенклатура → состав).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from app.db.session import SessionLocal  # noqa: E402
from app.models.areas import Area  # noqa: E402
from app.models.dictionaries import PartStage  # noqa: E402
from app.models.items import Item, ItemComponent, ItemKind  # noqa: E402
from app.models.part_counts import PartCountLine  # noqa: E402
from app.models.part_units import PartUnit, PartUnitEvent  # noqa: E402
from app.models.production import ProductionTaskLine  # noqa: E402

FACTORY = "fabrika"


def _is_film(stage: PartStage) -> bool:
    return stage.role == "film" or "окут" in stage.name.lower() or "ламин" in stage.name.lower()


def _stage_busy(db, stage: PartStage) -> list[str]:
    why = []
    if db.query(PartUnit.id).filter(PartUnit.stage_id == stage.id).first():
        why.append("партии")
    if db.query(PartUnitEvent.id).filter((PartUnitEvent.from_stage_id == stage.id) | (PartUnitEvent.to_stage_id == stage.id)).first():
        why.append("история партий")
    if db.query(ProductionTaskLine.id).filter(ProductionTaskLine.part_stage_id == stage.id).first():
        why.append("строки заданий")
    if db.query(PartCountLine.id).filter(PartCountLine.stage_id == stage.id).first():
        why.append("пересчёты")
    return why


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        if db.get(Area, FACTORY) is None:
            print(f"Нет участка {FACTORY}")
            sys.exit(1)
        kinds = {k.code: k.id for k in db.query(ItemKind)}
        products = (
            db.query(Item)
            .filter(Item.kind_id == kinds["izdelie"], Item.direction == "trim", Item.is_active.is_(True))
            .order_by(Item.name)
            .all()
        )
        unpaired: list[str] = []
        for it in products:
            notes = []
            if it.stage != "laminated":
                it.stage = "laminated"
                notes.append("признак «деталь в плёнке»")
            comps = db.query(ItemComponent).filter(ItemComponent.parent_item_id == it.id).all()
            pf = [c for c in comps if (b := db.get(Item, c.component_item_id)) is not None and b.kind_id == kinds["pf"]]
            if len(pf) != 1:
                unpaired.append(it.name)
                print(f"  {it.name}: {', '.join(notes) or 'без изменений'}; пары-п/ф нет — выбрать вручную")
                continue
            comp = pf[0]
            base = db.get(Item, comp.component_item_id)
            own = sorted(it.stages, key=lambda s: s.sequence_order)
            if not own:
                film = next((s for s in base.stages if _is_film(s)), None)
                st = PartStage(item_id=it.id, part_id=None, sequence_order=1, code="okutka", name="Окутка", area=FACTORY, role="film")
                db.add(st)
                db.flush()
                comp.stage_id = st.id
                notes.append("маршрут: Окутка (Фабрика), п/ф расходуется на ней")
                if film is not None:
                    busy = _stage_busy(db, film)
                    if busy:
                        notes.append(f"окутку у п/ф «{base.name}» не снимаю — на ней {', '.join(busy)}")
                    else:
                        db.query(ItemComponent).filter(ItemComponent.stage_id == film.id).update({ItemComponent.stage_id: None})
                        db.delete(film)
                        notes.append(f"у п/ф «{base.name}» окутка снята — он неламинированный")
            elif comp.stage_id is None:
                comp.stage_id = own[-1].id
                notes.append(f"п/ф расходуется на «{own[-1].name}»")
            print(f"  {it.name} ← {base.name}: {', '.join(notes) or 'уже настроено'}")
        if unpaired:
            print(f"Без пары-п/ф: {len(unpaired)}")
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
