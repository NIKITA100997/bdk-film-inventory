"""Столбцы строки двери как в Excel-мониторе щитовых (13.10): № счёта |
Серия | Размер | Цвет | Наименование (как в графике/счёте 1С) — каждое в
своём столбце, без повторов размера в названии и в характеристиках. Плюс
кромка — для фрезеровки периметра: у ABS обязательно её толщина."""

import re

_THICK = re.compile(r"(\d+(?:[.,]\d+)?)\s*мм", re.I)


def _num(v) -> str:
    return re.sub(r"\s*мм$", "", str(v or "")).strip()


def edge_label(by: dict, text: str = "") -> str:
    """«ABS 2 мм, черная» / «алюминий Black»; ABS без толщины — «ABS —
    толщина?» (видно, что надо уточнить)."""
    p = edge_parts(by, text)
    if not p.get("edge_type"):
        return ""
    if "?" in p["edge_type"]:
        return p["edge_type"] + (f" ({p['edge_color']})" if p.get("edge_color") else "")
    return p["edge_type"] + (f", {p['edge_color']}" if p.get("edge_color") else "")


_SIDES = re.compile(r"(?<!\d)([24])\s*-?\s*(?:х|x|сторон\w*)", re.I)


def edge_parts(by: dict, text: str) -> dict:
    """Кромка по столбцам (20.10, лист «Кромка»): тип с толщиной («ABS 2 мм»,
    «ПЭТ 1 мм», «алюминий»), цвет и сколько сторон — из наименования
    («кромка 4х», «кромка с 2-х сторон»)."""
    kind = str(by.get("кромка") or "").lower()
    color = str(by.get("цвет_кромки") or "").strip()
    m = _SIDES.search(text or "")
    sides = int(m.group(1)) if m else None

    if not kind and not color:
        # Извлечение параметров кромки из текста (названия детали или строки заказа)
        m_edge = re.search(r"кромк[а-я]*\s+([^,;]+)", text or "", re.I)
        edge_raw = m_edge.group(1).strip() if m_edge else ""
        if not edge_raw and ("алюм" in (text or "").lower() or "alum" in (text or "").lower()):
            edge_raw = "алюминий"
        if not edge_raw:
            return {"edge_type": "", "edge_color": "", "edge_sides": sides}

        th_m = _THICK.search(edge_raw)
        th_val = th_m.group(1).replace(".", ",") if th_m else ""
        pet = bool(re.search(r"(?i)\bпэт\b|\bpet\b", edge_raw))
        alum = bool(re.search(r"(?i)алюм|alum", edge_raw))
        abs_kind = bool(re.search(r"(?i)\babs\b|\bабс\b", edge_raw))

        if alum:
            edge_type = "алюминий"
        elif pet:
            edge_type = f"ПЭТ {th_val} мм" if th_val else "ПЭТ"
        elif abs_kind or th_val:
            edge_type = f"ABS {th_val} мм" if th_val else "ABS"
        else:
            edge_type = "ABS" if edge_raw else ""

        color_clean = edge_raw
        color_clean = re.sub(r"(?i)\babs\b|\bабс\b|\bпэт\b|\bpet\b|алюмин\w*|alum\w*", "", color_clean)
        color_clean = re.sub(r"\d+(?:[.,]\d+)?\s*мм", "", color_clean, flags=re.I)
        color_clean = re.sub(r"(?:с\s*)?\d\s*-?\s*(?:х|x|сторон\w*)", "", color_clean, flags=re.I)
        color_clean = " ".join(color_clean.split()).strip()

        return {
            "edge_type": edge_type,
            "edge_color": color_clean,
            "edge_sides": sides,
        }

    if "алюм" in kind or "alum" in kind:
        return {"edge_type": "алюминий", "edge_color": color, "edge_sides": sides}
    th = _THICK.search(color)
    pet = re.search(r"(?i)пэт|pet", color)
    rest = re.sub(r"(?i)\babs\b|пэт|\bpet\b", " ", _THICK.sub(" ", color))
    rest = " ".join(rest.split())
    base = "ПЭТ" if pet else "ABS"
    return {
        "edge_type": f"{base} {th.group(1).replace('.', ',')} мм" if th else f"{base} — толщина?",
        "edge_color": rest,
        "edge_sides": sides,
    }


def door_cols(chars: list[dict], source: str | None = None, fallback_name: str | None = None) -> dict:
    by = {c["code"]: c["value"] for c in chars or []}
    w, h = _num(by.get("ширина")), _num(by.get("высота"))
    t = _num(by.get("толщина"))
    src = (source or fallback_name or "").strip()
    if t and w and h:
        size_str = f"{t}х{w}х{h}"
    elif w and h:
        size_str = f"{w}х{h}"
    else:
        # Приоритет дверных габаритов (напр. 800х2000 или 24х810х2010), исключая мелкие молдинги вроде 5х3
        m_s = re.search(r"\b(?:(\d{1,2}(?:[.,]\d+)?)\s*[хx]\s*)?(\d{3,4}\s*[хx]\s*\d{3,4})\b", src)
        if not m_s:
            m_s = re.search(r"(\d+(?:[.,]\d+)?\s*[хx]\s*\d+(?:\s*[хx]\s*\d+)?)", src)
        size_str = m_s.group(0 if m_s and m_s.lastindex is None else 0).replace(" ", "") if m_s else ""

    col = str(by.get("цвет") or "")
    if not col:
        # 1. Шаблон 1С: ' - <ЦВЕТ>'
        m_dash = re.search(r"-\s+([А-Яа-яЁёA-Za-z0-9\s\-]+?)(?:\s*\(|\s+кромка|\s+Молдинг|\s+стекло|\s+под\s+замок|\s+с\s+молдинг|$)", src)
        if m_dash:
            col = m_dash.group(1).strip()
        # 2. Шаблон по типу плёнки: (ПЭТ|ПВХ|Полипропилен) ...
        if not col:
            m_c = re.search(r"\((?:ПЭТ|ПВХ|Полипропилен)\s+([^,)]+)", src)
            if not m_c:
                m_c = re.search(r"(?:ПЭТ|ПВХ|Полипропилен)\s+([А-Яа-яЁёA-Za-z0-9\s\-]+?)(?:,|\s+с\s+|\s+под\s+|$)", src)
            if m_c:
                col = m_c.group(1).strip()
        if not col and fallback_name:
            m_fn = re.search(r"(?:ПЭТ|ПВХ|Полипропилен)\s+([А-Яа-яЁёA-Za-z0-9\s\-]+?)(?:,|\s+с\s+|\s+под\s+|$)", fallback_name)
            if m_fn:
                col = m_fn.group(1).strip()

    # Дедупликация повторов в наименовании декора (напр. 'Белый матовый EVO Белый матовый EVO')
    if col:
        parts = col.split()
        half = len(parts) // 2
        if half > 0 and parts[:half] == parts[half:half*2]:
            col = " ".join(parts[:half])

    combined_text = " ".join(filter(None, [source, fallback_name]))
    ep = edge_parts(by, combined_text)
    return {
        "series": str(by.get("серия") or "") or (re.search(r"\b([А-ЯA-Z]-\d+(?:\.\d+)?)\b", src).group(1) if re.search(r"\b([А-ЯA-Z]-\d+(?:\.\d+)?)\b", src) else ""),
        "size": size_str,
        "color": col,
        "source": src,
        "edge": edge_label(by, combined_text),
        **ep,
    }
