"""Данные после выкладки 07.10.2026 (решения пользователя 06–07.10).

  --rights    А2: «Пересчёт п/ф» — Начальник цеха, Начальник участка;
              «Отгрузка готовой» — Кладовщик, Логист/руководитель, Начальник цеха.
  --new-pf    А4: три п/ф погонажа, которых нет (маршрут — как у «Коробка мдф
              75х32х2070 c уплотнителем», группа «Погонаж»).
  --link      А3: связать строки заданий погонажа с деталями по таблице
              (как кнопка «Связать»: ссылка + синоним названия).
  --no-return Е1: участки ламинации и прессов — «остатки плёнки не возвращают».

Без --apply только показывает. Пример:
    .venv\\Scripts\\python scripts\\post_deploy_0710.py --rights --new-pf --link --no-return
"""

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from sqlalchemy import func  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.models.areas import Area  # noqa: E402
from app.models.dictionaries import Part, PartStage  # noqa: E402
from app.models.items import Item, ItemGroup, PartAlias, normalize_name, strip_decor  # noqa: E402
from app.models.production import ProductionTask, ProductionTaskLine  # noqa: E402
from app.models.roles import Permission, Role  # noqa: E402
from app.models.users import User  # noqa: E402

RIGHTS = {
    "part_units.count": ["Начальник цеха", "Начальник участка"],
    "fg.ship": ["Кладовщик", "Логист/руководитель", "Начальник цеха"],
}
NEW_PF = [
    "Стык. планка телескоп 22х40х2070",
    "Коробка с упл. НЕ телескоп СЭНДВ 32х75х2070",
    "Коробка с упл. (серо-белый) телескоп (серия Б) МДФ 32х70х2070",
]
ROUTE_SAMPLE = "Коробка мдф 75х32х2070 c уплотнителем"
# название в строке задания (без декора) → деталь
LINKS = {
    "Наличник телескоп 8х70х2150": "Наличник 8х70х2150 телескоп",
    "Коробка с упл. телескоп МДФ 32х75х2070": "Коробка мдф 75х32х2070 c уплотнителем",
    "Добор телескоп 10х100х2070": "Добор телескоп 100х2070",
    "Добор телескоп 10х150х2070": "Добор телескоп 150х2070",
    "Добор телескоп 10х200х2070": "Добор телескоп 200х2070",
    "Плинтус МДФ 16х80х2070": "Плинтус 16х80х2070",
    "Стык. планка телескоп 22х40х2070": "Стык. планка телескоп 22х40х2070",
    "Коробка с упл. НЕ телескоп СЭНДВ 32х75х2070": "Коробка с упл. НЕ телескоп СЭНДВ 32х75х2070",
    "Коробка с упл. (серо-белый) телескоп (серия Б) МДФ 32х70х2070": "Коробка с упл. (серо-белый) телескоп (серия Б) МДФ 32х70х2070",
}


def rights(db) -> None:
    for code, roles in RIGHTS.items():
        perm = db.query(Permission).filter(Permission.code == code).first()
        if perm is None:
            print(f"  права {code} нет — миграции не применены?")
            continue
        for rn in roles:
            role = db.query(Role).filter(Role.name == rn).first()
            if role is None:
                print(f"  роли «{rn}» нет — пропуск")
            elif perm in role.permissions:
                print(f"  «{rn}» уже имеет {code}")
            else:
                role.permissions.append(perm)
                print(f"  «{rn}» + {code}")


def new_pf(db) -> None:
    sample = db.query(Part).filter(Part.name == ROUTE_SAMPLE).first()
    group = db.query(ItemGroup).filter(ItemGroup.name == "Погонаж").first()
    for name in NEW_PF:
        if db.query(Part).filter(func.lower(Part.name) == name.lower()).first():
            print(f"  «{name}» уже есть")
            continue
        p = Part(name=name, width_mm=sample.width_mm if sample else 0, length_m=sample.length_m if sample else 2.07, is_active=True)
        db.add(p)
        db.flush()
        item = p.item or db.get(Item, p.item_id)
        if item is not None:
            if group is not None:
                item.group_id = group.id
            si = db.get(Item, sample.item_id) if sample and sample.item_id else None
            if si is not None:
                item.direction, item.stage, item.type_id = si.direction, si.stage, si.type_id
        for st in sorted(sample.stages, key=lambda s: s.sequence_order) if sample else []:
            db.add(PartStage(part_id=p.id, item_id=p.item_id, sequence_order=st.sequence_order, code=st.code, name=st.name,
                             area=st.area, role=st.role))
        print(f"  новый п/ф «{name}» (маршрут как у «{ROUTE_SAMPLE}»)")
    db.flush()


def link(db, admin_id: int) -> None:
    parts = {normalize_name(p.name): p for p in db.query(Part).filter(Part.is_active.is_(True))}
    want = {normalize_name(k): v for k, v in LINKS.items()}
    done, miss = Counter(), Counter()
    for ln in db.query(ProductionTaskLine).filter(ProductionTaskLine.part_name.isnot(None), ProductionTaskLine.part_id.is_(None)):
        key = normalize_name(strip_decor(ln.part_name) if ln.color_id is not None else ln.part_name)
        target = want.get(key)
        part = parts.get(normalize_name(target)) if target else None
        if part is None:
            miss[strip_decor(ln.part_name) if ln.color_id is not None else ln.part_name] += 1
            continue
        ln.part_id = part.id
        done[part.name] += 1
        if key != normalize_name(part.name) and not db.query(PartAlias).filter(PartAlias.alias == key).first():
            db.add(PartAlias(alias=key, part_id=part.id, created_by=admin_id))
            db.flush()
    print(f"  связано строк: {sum(done.values())}")
    for k, v in done.most_common():
        print(f"    {v:4} → {k}")
    if miss:
        print(f"  без связи осталось групп: {len(miss)}")
        for k, v in miss.most_common(15):
            print(f"    {v:4}  {k}")


def no_return(db) -> None:
    for a in db.query(Area).filter(Area.is_active.is_(True)):
        n = a.name.lower()
        if ("ламинац" in n or "пресс" in n or a.code == "fabrika") and not a.film_no_return:
            a.film_no_return = True
            print(f"  «{a.name}»: остатки плёнки не возвращают")


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.is_superuser.is_(True)).order_by(User.id).first()
        if "--rights" in sys.argv:
            print("А2 права:")
            rights(db)
        if "--new-pf" in sys.argv:
            print("А4 новые п/ф погонажа:")
            new_pf(db)
        if "--link" in sys.argv:
            print("А3 связка строк погонажа:")
            link(db, admin.id)
        if "--no-return" in sys.argv:
            print("Е1 участки без возврата плёнки:")
            no_return(db)
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
