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

import re
from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.production import ProductionTaskLine
from app.services.door_cols import door_cols

POSITION = "позиция"  # псевдопризнак: позиция целиком (упаковка — одинаковые двери из разных счетов)


def fallback_door_chars(part_name: str | None, width_mm: float | None = None, length_m: float | None = None) -> list[dict]:
    """Извлечение характеристик двери из названия (если type_id/chars не заполнены в БД)."""
    if not part_name:
        return []
    dc = door_cols([], fallback_name=part_name)
    chars = []
    if dc.get("series"):
        chars.append({"code": "серия", "name": "Серия", "value": dc["series"]})

    sz = dc.get("size") or ""
    m = re.match(r"(\d+)\s*[хx]\s*(\d+)", sz)
    if m:
        chars.append({"code": "ширина", "name": "Ширина", "value": f"{m.group(1)} мм"})
        chars.append({"code": "высота", "name": "Высота", "value": f"{m.group(2)} мм"})
    elif width_mm and float(width_mm) > 0:
        chars.append({"code": "ширина", "name": "Ширина", "value": f"{int(round(float(width_mm)))} мм"})
        if length_m and float(length_m) > 0:
            chars.append({"code": "высота", "name": "Высота", "value": f"{int(round(float(length_m) * 1000))} мм"})

    m_col = re.search(r"((?:ПЭТ|ПВХ|Полипропилен)\s+[А-Яа-яA-Za-z0-9\s\-]+?)(?:,|\s+с\s+|\s+под\s+|$)", part_name)
    color_val = m_col.group(1).strip() if m_col else dc.get("color")
    if color_val:
        chars.append({"code": "цвет", "name": "Цвет", "value": color_val})

    m_edge = re.search(r"кромк[а-я]*\s+([^,;]+)", part_name, re.I)
    edge_raw = m_edge.group(1).strip() if m_edge else ""

    et = dc.get("edge_type") or ""
    if "abs" in et.lower() or "abs" in edge_raw.lower():
        chars.append({"code": "кромка", "name": "Кромка", "value": "ABS"})
    elif "пэт" in et.lower() or "пэт" in edge_raw.lower():
        chars.append({"code": "кромка", "name": "Кромка", "value": "ПЭТ"})
    elif "алюм" in et.lower() or "алюм" in edge_raw.lower():
        chars.append({"code": "кромка", "name": "Кромка", "value": "aluminum"})
    elif et:
        chars.append({"code": "кромка", "name": "Кромка", "value": et})

    if edge_raw:
        chars.append({"code": "цвет_кромки", "name": "Цвет кромки", "value": edge_raw})
    elif dc.get("edge_color"):
        chars.append({"code": "цвет_кромки", "name": "Цвет кромки", "value": dc["edge_color"]})

    return chars


def _area_props(db: Session, area_code: str) -> list[str]:
    cache = db.info.setdefault("area_group_props", {})
    if area_code not in cache:
        a = db.get(Area, area_code)
        cache[area_code] = list(a.group_props or []) if a is not None else []
    return cache[area_code]


def line_group(db: Session, line: ProductionTaskLine, area_code: str, chars: list[dict] | None = None) -> tuple[str, str] | None:
    """(ключ, подпись) группы строки или None — участок не группирует.
    chars — характеристики позиции строки (как в ProductionTaskLineOut)."""
    if line.material_id:
        # Для строк с плёнкой (окутка царговых, щитовые двери):
        # группируем по эффективной ширине штрипса и декору плёнки
        from app.models.dictionaries import Material, Color
        from app.services.production import calc_default_strip_width

        sw = float(line.strip_width_mm) if line.strip_width_mm is not None else calc_default_strip_width(line.part_name, float(line.width_mm))
        mat = db.get(Material, line.material_id)
        col = db.get(Color, line.color_id) if line.color_id else None
        film_str = f"{mat.name if mat else ''} {col.name if col else ''}".strip() or "Плёнка"
        sw_str = f"{sw:.0f}" if sw.is_integer() else f"{sw:.1f}"
        return f"sw:{sw_str}:{line.material_id}:{line.color_id or 0}", f"Штрипс {sw_str} мм · {film_str}"

    if line.part_id or (line.part_name and ("каркас" in line.part_name.lower() or "брусок" in line.part_name.lower())):
        label = line.part_name or ""
        if line.program:
            label += f" · {line.program}"
        key = f"p:{line.part_id or line.part_name}:{line.part_stage_id or 0}:{line.program or ''}"
        return key, label

    props = _area_props(db, area_code)
    if not props:
        return None

    effective_chars = chars or fallback_door_chars(line.part_name, line.width_mm, line.length_m)
    if not effective_chars and POSITION not in props:
        return None

    by_code = {c["code"]: c for c in effective_chars or []}
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
