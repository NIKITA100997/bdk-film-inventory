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
    m = _THICK.search(color)
    rest = re.sub(r"(?i)\babs\b", " ", _THICK.sub(" ", color))
    rest = " ".join(rest.split())
    return f"ABS {m.group(1).replace('.', ',')} мм" + (f", {rest}" if rest else "") if m else "ABS — толщина?" + (f" ({color})" if color else "")


def door_cols(chars: list[dict], source: str | None = None, fallback_name: str | None = None) -> dict:
    by = {c["code"]: c["value"] for c in chars or []}
    w, h = _num(by.get("ширина")), _num(by.get("высота"))
    return {
        "series": str(by.get("серия") or ""),
        "size": f"{w}х{h}" if w and h else "",
        "color": str(by.get("цвет") or ""),
        "source": (source or fallback_name or "").strip(),
        "edge": edge_label(by),
    }
