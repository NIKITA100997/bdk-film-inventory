"""Разбор графика запуска щитовых дверей (раздел про производство щитовых
дверей). Чистые функции без БД — сопоставление серии, размер, признаки
строки из наименования и разбор вставленного из Excel графика."""

import re
from dataclasses import dataclass
from datetime import date

# Латиница, набранная вместо похожей кириллицы в названии серии.
_LATIN_TO_CYR = str.maketrans({"A": "А", "B": "В", "E": "Е", "H": "Н", "O": "О", "X": "Х"})


def series_key(name: str) -> str:
    """Ключ сопоставления серии из графика со справочником: «В-10.2» → то же,
    что «В-10» (вариант .1/.2 — модификация той же серии), «Н-1 ВО» → то же,
    что «Н1 ВО»."""
    s = name.strip().upper().translate(_LATIN_TO_CYR)
    s = re.sub(r"\.\d+$", "", s)
    return re.sub(r"[\s\-]", "", s)


_SIZE_RE = re.compile(r"^\s*(\d{2,4})\s*[хxX×*Х]\s*(\d{3,4})\s*$")


def parse_size(text: str) -> tuple[int, int] | None:
    """«800х2000» → (800, 2000): ширина, высота двери в мм."""
    m = _SIZE_RE.match(text or "")
    return (int(m.group(1)), int(m.group(2))) if m else None


@dataclass(frozen=True)
class LineFeatures:
    edge_type: str
    has_glass: bool
    has_moulding: bool
    needs_lock_milling: bool
    glass: str = ""  # вид стекла: «Черное», «Зеркало ГРАФИТ»; «есть» — без вида; "" — без стекла
    edge_text: str = ""  # кромка как в наименовании: «черная ABS 2мм», «ПЭТ Белая 1мм», «Black»


# Последняя «кромка …» в наименовании — сама кромка двери; «кромка 4х» и
# «кромка с 4-х сторон …» описывают только стороны и отбрасываются.
_EDGE_RE = re.compile(r"кромка\s+(.+?)(?=\s*(?:молдинг|кромка|\(|\)|$))", re.IGNORECASE)
_ALUMINUM_EDGE_RE = re.compile(r"^(black|silver)$", re.IGNORECASE)
_BANDING_EDGE_RE = re.compile(r"abs|пэт|\d\s*мм", re.IGNORECASE)
_GLASS_RE = re.compile(r"\bстекло\s+([^()]+?)\s*(?=\)|\s+кромк|\s+молдинг|$)", re.IGNORECASE)


def parse_line_features(name: str, default_edge: str) -> LineFeatures:
    """Признаки строки графика из её наименования. Кромка: «кромка
    Black/Silver» (только цвет) — алюминиевый профиль; «кромка черная ABS
    2мм»/«кромка ПЭТ Белая 1мм» — кромкооблицовка; иначе — по серии.
    Фрезеровка под замок — «Защелка» или «PL410»."""
    edges = [e for e in _EDGE_RE.findall(name or "") if not re.match(r"^(с\s|\d)", e.strip(), re.IGNORECASE)]
    edge_type = default_edge
    last = ""
    if edges:
        last = edges[-1].strip()
        if _ALUMINUM_EDGE_RE.match(last):
            edge_type = "aluminum"
        elif _BANDING_EDGE_RE.search(last):
            edge_type = "abs"
    has_glass = bool(re.search(r"стекл", name or "", re.IGNORECASE))
    glass = _GLASS_RE.search(name or "")
    return LineFeatures(
        edge_type=edge_type,
        glass=" ".join(glass.group(1).split()) if glass else ("есть" if has_glass else ""),
        edge_text=" ".join(last.split()),
        has_glass=has_glass,
        has_moulding=bool(re.search(r"молдинг|\(м\d", name, re.IGNORECASE)),
        needs_lock_milling=bool(re.search(r"защ[её]лк|pl\s*410", name, re.IGNORECASE)),
    )


@dataclass(frozen=True)
class ScheduleRow:
    ship_date: date | None
    invoice_no: str
    series_text: str
    size_text: str
    color_text: str
    name_text: str
    doors_qty: int


def _parse_date(text: str) -> date | None:
    m = re.match(r"^\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s*$", text or "")
    if not m:
        return None
    day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if year < 100:
        year += 2000
    try:
        return date(year, month, day)
    except ValueError:
        return None


def parse_pasted_schedule(text: str) -> tuple[list[ScheduleRow], list[str]]:
    """Строки, скопированные из листа «График» (колонки: Дата отгрузки,
    № счёта, Серия, Размер, Цвет, Наименование, Кол-во дверей), вставлены
    как текст с табуляциями. Шапку, пустые строки и строки-заглушки
    шаблона (#VALUE!) пропускаем молча; прочие непонятные — в ошибки с
    номером строки, чтобы их было видно в предпросмотре."""
    rows: list[ScheduleRow] = []
    errors: list[str] = []
    for i, raw in enumerate(text.splitlines(), 1):
        cells = [c.strip() for c in raw.split("\t")]
        if not any(cells) or any(c.startswith("#") for c in cells[2:5]):
            continue
        if len(cells) < 7:
            cells += [""] * (7 - len(cells))
        ship, invoice, series, size, color, name, qty = cells[:7]
        if series.lower() == "серия":
            continue
        if not series or not name:
            errors.append(f"Строка {i}: нет серии или наименования")
            continue
        qty_digits = re.sub(r"\s", "", qty)
        if not qty_digits.isdigit() or int(qty_digits) <= 0:
            errors.append(f"Строка {i}: не число в «Кол-во дверей» — «{qty}»")
            continue
        rows.append(
            ScheduleRow(
                ship_date=_parse_date(ship),
                invoice_no=invoice,
                series_text=series,
                size_text=size,
                color_text=color,
                name_text=name,
                doors_qty=int(qty_digits),
            )
        )
    return rows, errors
