"""Первичная разметка признаков номенклатуры: направление и стадия.

Типам — по названию типа; позициям — только там, где тип не решает
(«Деталь МК/панели» и «Заготовка п/ф» — по свойству «линия»; позиции
без типа — по группе). Режим не проставляется: он выводится по правилу
(services/item_attrs.default_mode), у позиции — только исключения.

    .venv\\Scripts\\python scripts\\setup_item_attrs.py           — показать, что будет
    .venv\\Scripts\\python scripts\\setup_item_attrs.py --apply   — записать

Повторный запуск безопасен: уже заданное не перетирается.
"""

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from app.db.session import SessionLocal  # noqa: E402
from app.models.items import Item, ItemGroup, ItemKind, ItemProperty, ItemPropertyOption, ItemPropertyValue, ItemType  # noqa: E402
from app.services.item_attrs import DIRECTIONS, STAGES  # noqa: E402

# Тип → (направление, стадия). None — решается по позиции.
TYPE_ATTRS = {
    "Деталь МК/панели": (None, "bare"),
    "Заготовка п/ф": (None, "blank"),
    "Заготовка МДФ": ("shield", "blank"),
    "Каркас щитовой двери": ("shield", "blank"),
    "Панель щитовая фрезерованная": ("shield", "bare"),
    "Панель щитовая ламинированная": ("shield", "laminated"),
    "Панель щитовая с узором": ("shield", "laminated"),
    "Щитовая дверь": ("shield", None),
    "Царговая дверь": ("tsarg", None),
}
LINE_DIRECTION = {"МК": "tsarg", "Панели": "panel"}
# Верхняя группа п/ф → направление; подгруппа → стадия.
GROUP_DIRECTION = {"МК": "tsarg", "Панели (металлические двери)": "panel", "Щитовые": "shield", "Погонаж": "trim"}
GROUP_STAGE = {"Заготовки": "blank", "Детали": "bare"}
# Последний шаг — по названию (начало названия, без регистра).
NAME_DIRECTION = [(("добор", "коробка", "наличник", "планка", "плинтус"), "trim")]
NAME_STAGE = [
    (("заготовка", "стойка каркаса", "поперечная каркаса", "усилитель каркаса", "вставка замковая"), "blank"),
    (("панель щитовой двери",), "bare"),  # без цвета — до ламинации
]


def by_name(rules, name: str) -> str | None:
    low = name.lower().strip()
    return next((v for prefixes, v in rules if low.startswith(prefixes)), None)


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        kinds = {k.id: k.code for k in db.query(ItemKind)}
        groups = {g.id: g for g in db.query(ItemGroup)}
        types = {t.id: t for t in db.query(ItemType)}

        print("== Типы")
        for t in types.values():
            if t.name not in TYPE_ATTRS:
                continue
            d, s = TYPE_ATTRS[t.name]
            new_d = t.direction or d
            new_s = t.stage or s
            if (new_d, new_s) != (t.direction, t.stage):
                print(f"  {t.name}: направление {DIRECTIONS.get(new_d, '—')}, стадия {STAGES.get(new_s, '—')}")
                t.direction, t.stage = new_d, new_s

        # Значение свойства «линия» у позиций.
        line_of: dict[int, str] = {}
        for v, o in (
            db.query(ItemPropertyValue, ItemPropertyOption)
            .join(ItemProperty, ItemProperty.id == ItemPropertyValue.property_id)
            .join(ItemPropertyOption, ItemPropertyOption.id == ItemPropertyValue.option_id)
            .filter(ItemProperty.code == "линия")
        ):
            line_of[v.item_id] = o.value

        def top_and_sub(item: Item) -> tuple[str | None, str | None]:
            g = groups.get(item.group_id) if item.group_id else None
            if g is None:
                return None, None
            if g.parent_id and g.parent_id in groups:
                return groups[g.parent_id].name, g.name
            return g.name, None

        print("== Позиции")
        stat: Counter = Counter()
        unresolved = []
        for item in db.query(Item).filter(Item.is_active.is_(True)).order_by(Item.id):
            kind = kinds.get(item.kind_id)
            if kind not in ("pf", "izdelie"):
                continue
            t = types.get(item.type_id) if item.type_id else None
            t_dir, t_stage = (t.direction, t.stage) if t else (None, None)
            top, sub = top_and_sub(item)
            d = item.direction or t_dir
            s = item.stage or t_stage
            if d is None:
                d = (
                    LINE_DIRECTION.get(line_of.get(item.id, ""))
                    or GROUP_DIRECTION.get(top or "")
                    or by_name(NAME_DIRECTION, item.name)
                )
                if d and d != t_dir:
                    item.direction = d
                    stat[f"направление позиции → {DIRECTIONS[d]}"] += 1
            if kind == "pf" and s is None:
                s = GROUP_STAGE.get(sub or "")
                if s is None and top == "Погонаж":
                    s = "bare"
                if s is None:
                    s = by_name(NAME_STAGE, item.name)
                if s:
                    item.stage = s
                    stat[f"стадия позиции → {STAGES[s]}"] += 1
            if d is None or (kind == "pf" and s is None):
                unresolved.append(f"  [{kind}] {item.name} (группа: {top or '—'}/{sub or '—'}, тип: {t.name if t else '—'})")
        for k, n in sorted(stat.items()):
            print(f"  {k}: {n}")
        print(f"== Не решено автоматически: {len(unresolved)} (проставить на экране «Номенклатура»)")
        for u in unresolved[:60]:
            print(u)
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
