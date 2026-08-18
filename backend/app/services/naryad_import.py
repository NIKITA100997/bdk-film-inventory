"""Раздел про загрузку наряд-заказа как способ создания производственного
задания — печатная форма («Перечень деталей столярных изделий», раздел
«РАСКЛАДКА») содержит физическую форму деталей (название/ширина/длина/
кол-во), но не плёнку (материал/цвет для окутки выбираются отдельно, уже
в приложении — раздел 14 бэклога).

Разбор устроен в два слоя: parse_naryad_grid — чистая функция над готовой
сеткой ячеек (тестируется без реального .xls-файла), parse_naryad_xls_bytes
— тонкая обёртка, читающая .xls через xlrd и передающая сетку дальше.
Колонки таблицы деталей определяются по тексту заголовков ("Деталь",
"Ширина", "Длина", "Кол-во"), а не по фиксированным номерам — печатные
формы этой ERP используют неодинаковую раскладку колонок между файлами."""

from dataclasses import dataclass, field

import xlrd

RASKLADKA_MARKER = "раскладка"
STOP_MARKERS = ("ведомость", "#оттискктокогда#")
HEADER_ALIASES = {
    "деталь": "part_name",
    "ширина": "width_mm",
    "длина": "length_mm",
    "кол-во": "quantity_pieces",
}


@dataclass(frozen=True)
class ParsedNaryadLine:
    part_name: str
    width_mm: float
    length_m: float
    quantity_pieces: float


@dataclass(frozen=True)
class NaryadParseResult:
    suggested_name: str
    lines: list[ParsedNaryadLine] = field(default_factory=list)


def _is_stop_row(row: list) -> bool:
    return any(isinstance(cell, str) and any(marker in cell.strip().lower() for marker in STOP_MARKERS) for cell in row)


def parse_naryad_grid(rows: list[list]) -> NaryadParseResult:
    """rows[r][c] — значение ячейки (xlrd отдаёт числа как float, текст —
    как str, пустая ячейка — как ""). Поднимает ValueError с понятным
    сообщением, если структура не похожа на наряд-заказ — вызывающий код
    превращает это в 422 с тем же текстом."""
    header_row_idx: int | None = None
    order_number: int | None = None
    model_label: str | None = None

    for r, row in enumerate(rows):
        if any(isinstance(cell, str) and cell.strip().lower() == RASKLADKA_MARKER for cell in row):
            header_row_idx = r
            break
        for cell in row:
            if isinstance(cell, (int, float)) and order_number is None:
                order_number = int(cell)
            elif isinstance(cell, str) and cell.strip() and model_label is None:
                text = cell.strip()
                # "#ОттискКтоКогда#" — служебный плейсхолдер печатной формы
                # (место под штамп/подпись), не название модели.
                if text.lower() not in STOP_MARKERS:
                    model_label = text

    if header_row_idx is None:
        raise ValueError('Не найден раздел "РАСКЛАДКА" — не похоже на печатную форму наряд-заказа')

    col_map: dict[str, int] = {}
    data_start: int | None = None
    for r in range(header_row_idx + 1, len(rows)):
        found: dict[str, int] = {}
        for c, cell in enumerate(rows[r]):
            if not isinstance(cell, str):
                continue
            key = cell.strip().lower().rstrip(".")
            for alias, field_name in HEADER_ALIASES.items():
                if key.startswith(alias.rstrip(".")):
                    found[field_name] = c
        if {"part_name", "width_mm", "length_mm", "quantity_pieces"} <= found.keys():
            col_map = found
            data_start = r + 1
            break

    if data_start is None:
        raise ValueError('Не найдена таблица деталей (колонки "Деталь"/"Ширина"/"Длина"/"Кол-во") после "РАСКЛАДКА"')

    lines: list[ParsedNaryadLine] = []
    for r in range(data_start, len(rows)):
        row = rows[r]
        if _is_stop_row(row):
            break

        def cell(field_name: str):
            idx = col_map[field_name]
            return row[idx] if idx < len(row) else ""

        name, width, length, qty = cell("part_name"), cell("width_mm"), cell("length_mm"), cell("quantity_pieces")
        if not (isinstance(width, (int, float)) and isinstance(length, (int, float)) and isinstance(qty, (int, float))):
            continue
        if width <= 0 or length <= 0 or qty <= 0:
            continue
        lines.append(
            ParsedNaryadLine(
                part_name=str(name).strip() if isinstance(name, str) else "",
                width_mm=float(width),
                length_m=round(float(length) / 1000, 4),
                quantity_pieces=float(qty),
            )
        )

    suggested_name = f"Заказ №{order_number}" if order_number is not None else "Наряд-заказ"
    if model_label:
        suggested_name += f" — {model_label}"
    return NaryadParseResult(suggested_name=suggested_name, lines=lines)


def parse_naryad_xls_bytes(data: bytes) -> NaryadParseResult:
    workbook = xlrd.open_workbook(file_contents=data)
    sheet = workbook.sheet_by_index(0)
    grid = [[sheet.cell_value(r, c) for c in range(sheet.ncols)] for r in range(sheet.nrows)]
    return parse_naryad_grid(grid)

