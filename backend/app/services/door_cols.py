"""Столбцы строки двери как в Excel-мониторе щитовых (13.10): № счёта |
Серия | Размер | Цвет | Наименование (как в графике/счёте 1С) — каждое в
своём столбце, без повторов размера в названии и в характеристиках. Плюс
кромка — для фрезеровки периметра: у ABS обязательно её толщина."""

import re

_THICK = re.compile(r"(\d+(?:[.,]\d+)?)\s*мм", re.I)


def _num(v) -> str:
    return re.sub(r"\s*мм$", "", str(v or "")).strip()


def edge_label(by: dict) -> str:
    """«ABS 2 мм, черная» / «алюминий Black»; ABS без толщины — «ABS —
    толщина?» (видно, что надо уточнить)."""
    kind = str(by.get("кромка") or "").lower()
    color = str(by.get("цвет_кромки") or "").strip()
    if not kind and not color:
        return ""
    if "алюм" in kind or "alum" in kind:
        return "алюминий" + (f" {color}" if color else "")
    p = edge_parts(by, "")
    if "?" in p["edge_type"]:
        return p["edge_type"] + (f" ({color})" if color else "")
    return p["edge_type"] + (f", {p['edge_color']}" if p["edge_color"] else "")


_SIDES = re.compile(r"кромк\w*\s*(?:с\s*)?(\d)\s*-?\s*(?:х|x)", re.I)


def edge_parts(by: dict, text: str) -> dict:
    """Кромка по столбцам (20.10, лист «Кромка»): тип с толщиной («ABS 2 мм»,
    «ПЭТ 1 мм», «алюминий»), цвет и сколько сторон — из наименования
    («кромка 4х», «кромка с 2-х сторон»)."""
    kind = str(by.get("кромка") or "").lower()
    color = str(by.get("цвет_кромки") or "").strip()
    m = _SIDES.search(text or "")
    sides = int(m.group(1)) if m else None
    if not kind and not color:
        return {"edge_type": "", "edge_color": "", "edge_sides": sides}
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
    src = (source or fallback_name or "").strip()
    return {
        "series": str(by.get("серия") or ""),
        "size": f"{w}х{h}" if w and h else "",
        "color": str(by.get("цвет") or ""),
        "source": src,
        "edge": edge_label(by),
        **edge_parts(by, " ".join(filter(None, [source, fallback_name]))),
    }
