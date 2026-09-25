"""Общие заготовки п/ф до фрезеровки (25.09.2026) — только данные.

По техкарте склеенных заготовок деталь одинакова до 4-сторонней фрезеровки:
паз и профиль появляются на ней. Решение пользователя: одинаковые размеры —
одна заготовка («Стоевая 36х108х2035 ПАЗ-11» и «… ПАЗ-4» — из «Заготовка
МК 36х108х2035»; «Поперечная 30х110х1840» и «Планка 30х110х1840» — тоже одна).

Для деталей групп «МК» и «Панели (металлические двери)» с маршрутом
«Склейка МДФ с заготовкой → Фрезеровка → Окутка»:
  • заготовка на размер (и группу): «Склейка МДФ с заготовкой» → «Готово»
    (без участка — общий запас, берётся с любого участка);
  • у детали остаётся «Фрезеровка → Окутка», на фрезеровке — 1 заготовка;
  • партии детали на «Склейке» и «Фрезеровке» (ещё не отфрезерованы) —
    это и есть заготовки: переходят в заготовку того же размера (номер
    партии и этикетка те же, в истории — «Корректировка»). Партии на
    «Окутке» не трогаются.
«МДФ» в названии («Стоевая 36х108х2035 МДФ») — другой материал, своя
заготовка. Повторяемо. Запуск из backend/:
    .venv/Scripts/python.exe scripts/setup_pf_blanks.py [--dry-run]"""

import re
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, ".")

from app.db.session import SessionLocal  # noqa: E402
from app.models.dictionaries import Part, PartStage  # noqa: E402
from app.models.items import Item, ItemComponent, ItemGroup  # noqa: E402
from app.models.part_units import PartEventType, PartUnit, PartUnitEvent  # noqa: E402
from app.models.users import User  # noqa: E402
from app.services.part_units import record_part_event  # noqa: E402
from app.services.routes import RouteStep, apply_route  # noqa: E402

DRY = "--dry-run" in sys.argv
GLUE, MILL, WRAP = "Склейка МДФ с заготовкой", "Фрезеровка", "Окутка"
GROUPS = {"МК": "МК", "Панели (металлические двери)": "(Панель)"}
SIZE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*[хx]\s*(\d+(?:[.,]\d+)?)\s*[хx]\s*(\d+(?:[.,]\d+)?)")
NOTE = "Общая заготовка до фрезеровки (25.09)"

db = SessionLocal()
admin = db.query(User).filter(User.is_superuser.is_(True), User.is_active.is_(True)).order_by(User.id).first()
groups = {g.id: g for g in db.query(ItemGroup).filter(ItemGroup.name.in_(GROUPS), ItemGroup.parent_id.is_(None))}

# Детали: нужная группа, маршрут «Склейка → Фрезеровка → Окутка», не заготовка.
by_blank: dict[tuple[int, str], list[Part]] = defaultdict(list)
skipped = []
for part in db.query(Part).join(Item, Item.id == Part.item_id).filter(Item.group_id.in_(groups)).order_by(Part.name):
    if part.name.startswith("Заготовка"):
        continue
    names = [s.name for s in sorted(part.stages, key=lambda s: s.sequence_order)]
    if names == [MILL, WRAP] and any(c.stage_id for c in db.query(ItemComponent).filter(ItemComponent.parent_item_id == part.item_id)):
        pass  # уже переведена — пересчитаем связь ниже как есть
    elif names != [GLUE, MILL, WRAP]:
        skipped.append(f"{part.name} (маршрут: {' → '.join(names) or 'нет'})")
        continue
    m = SIZE_RE.search(part.name)
    if not m:
        skipped.append(f"{part.name} (нет размера Т×Ш×Д в названии)")
        continue
    size = "х".join(x.replace(",", ".") for x in m.groups())
    if re.search(r"\bМДФ\b", part.name):
        size += " МДФ"
    by_blank[(part.item.group_id, size)].append(part)

created = moved_units = linked = 0
for (group_id, size), parts in sorted(by_blank.items(), key=lambda kv: (groups[kv[0][0]].name, kv[0][1])):
    name = f"Заготовка {GROUPS[groups[group_id].name]} {size}"
    blank = db.query(Part).filter(Part.name == name).first()
    if blank is None:
        t, w, length = (float(x) for x in re.findall(r"\d+(?:\.\d+)?", size)[:3])
        blank = Part(name=name, width_mm=w, length_m=round(length / 1000, 3), is_active=True)
        db.add(blank)
        db.flush()
        glue_area = next(s.area for s in parts[0].stages if s.name == GLUE) if any(s.name == GLUE for s in parts[0].stages) else None
        apply_route(db, blank, [RouteStep(code=GLUE, name=GLUE, area=glue_area), RouteStep(code="Готово", name="Готово", area=None)])
        db.flush()
        blank.item.group_id = group_id
        created += 1
    b_stages = {s.name: s for s in blank.stages}
    print(f"{name}  ←  " + ", ".join(p.name for p in parts))

    for part in parts:
        stages = {s.name: s for s in part.stages}
        glue, mill = stages.get(GLUE), stages[MILL]
        # Не отфрезерованные партии детали — это заготовки: в общий запас.
        for unit in db.query(PartUnit).filter(PartUnit.part_id == part.id, PartUnit.stage_id.in_([s.id for s in (glue, mill) if s])):
            to_stage = b_stages[GLUE] if glue is not None and unit.stage_id == glue.id else b_stages["Готово"]
            from_stage = unit.stage_id
            print(f"    партия №{unit.id} {float(unit.quantity_pieces):g} шт: «{part.name}» / {unit.stage.name} → «{name}» / {to_stage.name}")
            unit.part_id, unit.stage_id = blank.id, to_stage.id
            db.flush()
            record_part_event(
                db, unit=unit, event_type=PartEventType.KORREKTIROVKA, user_id=admin.id, from_stage_id=from_stage,
                to_stage_id=to_stage.id, note=f"{NOTE}: была «{part.name}»"[:255],
            )
            db.flush()  # autoflush выключен: событие должно попасть в базу до перевода истории ниже
            moved_units += 1
        if glue is not None:
            # История этапа «Склейка» детали — теперь на этапе заготовки.
            db.query(PartUnitEvent).filter(PartUnitEvent.from_stage_id == glue.id).update({"from_stage_id": b_stages[GLUE].id})
            db.query(PartUnitEvent).filter(PartUnitEvent.to_stage_id == glue.id).update({"to_stage_id": b_stages[GLUE].id})
            db.flush()
            apply_route(db, part, [RouteStep(code=s.code, name=s.name, area=s.area) for s in (mill, stages[WRAP])])
            db.flush()
        comp = (
            db.query(ItemComponent)
            .filter(ItemComponent.parent_item_id == part.item_id, ItemComponent.component_item_id == blank.item_id)
            .first()
        )
        if comp is None:
            db.add(ItemComponent(
                parent_item_id=part.item_id, component_item_id=blank.item_id, qty_per_unit=1, stage_id=mill.id,
                source="manual", sort_order=1,
            ))
            linked += 1
    db.flush()

print(f"\nзаготовок заведено: {created} (всего {len(by_blank)}), деталей связано: {linked}, партий перенесено: {moved_units}")
if skipped:
    print("пропущены:", *skipped, sep="\n  ")
if DRY:
    db.rollback()
    print("пробный прогон — ничего не записано")
else:
    db.commit()
