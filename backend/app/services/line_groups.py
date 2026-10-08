"""Группы строк заданий участка (08.10.2026).

Строки дверей рождаются по строкам заказа и так и остаются (ход заказа,
приход на склад готовой по счёту, себестоимость), но участку важны общие
признаки: склейке — серия, размер и цвет, кромке — вид и цвет кромки,
фрезеровке под замок — замок. У участка задан набор признаков
(Area.group_props — коды свойств типа позиции); строки с одинаковыми
значениями — одна группа: её видно в задании, на печатном листе и в
мониторе, отчёт по группе раскладывается по её строкам (раньше срок —
раньше).

Строки п/ф объединяются физически при запуске (services/release_merge.py),
здесь их группа — деталь (+ программа). Строки с плёнкой не группируются:
у каждой своя плёнка и рулон в отчёте."""

from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.production import ProductionTaskLine

POSITION = "позиция"  # псевдопризнак: позиция целиком (упаковка — одинаковые двери из разных счетов)


def _area_props(db: Session, area_code: str) -> list[str]:
    cache = db.info.setdefault("area_group_props", {})
    if area_code not in cache:
        a = db.get(Area, area_code)
        cache[area_code] = list(a.group_props or []) if a is not None else []
    return cache[area_code]


def line_group(db: Session, line: ProductionTaskLine, area_code: str, chars: list[dict] | None = None) -> tuple[str, str] | None:
    """(ключ, подпись) группы строки или None — участок не группирует.
    chars — характеристики позиции строки (как в ProductionTaskLineOut)."""
    props = _area_props(db, area_code)
    if not props:
        return None
    if line.material_id:
        # строка с плёнкой — своя плёнка и свой рулон в отчёте; одинаковые
        # (та же деталь и плёнка) уже слиты при запуске
        return None
    if line.part_id:
        label = line.part_name or ""
        if line.program:
            label += f" · {line.program}"
        return f"p:{line.part_id}:{line.part_stage_id}:{line.program or ''}", label
    if not chars and POSITION not in props:
        return None
    by_code = {c["code"]: c for c in chars or []}
    values = []
    for code in props:
        c = by_code.get(code)
        if code == POSITION:
            values.append((code, line.part_name or ""))
        elif c is None:
            values.append((code, None))
        else:
            values.append((code, c["value"] if c["value"] != "да" else c["name"]))
    key = "g:" + ";".join(f"{c}={v or ''}" for c, v in values)
    label = " · ".join(v for _, v in values if v) or "без признаков"
    return key, label
