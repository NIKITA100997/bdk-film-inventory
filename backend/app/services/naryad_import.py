"""Раздел про загрузку наряд-заказа как способ создания производственного
задания — печатная форма («Перечень деталей столярных изделий») бывает
двух видов: раздел «РАСКЛАДКА» (детали дверного полотна — стоевая/
поперечная/филёнка, с явными колонками ширина/длина/кол-во) и погонажная
(добор/наличник/короб — колонки «Кол-во ПЛАН» вместо явных
ширины/длины, сами размеры зашиты в текст названия, "10х100х2070").
Оба вида дают только физическую форму детали, не плёнку (материал/цвет
для окутки выбираются отдельно, уже в приложении — раздел 14 бэклога).
width_mm/length_m строки — это СОБСТВЕННАЯ ширина/длина детали (дерево/
МДФ-заготовка), не плёнки — ширина плёнки на укутку считается отдельно,
services.production.calc_default_strip_width (константы сверены с
формулами проекта C:\\Users\\User\\Downloads\\Calc, interior_material_cost.py).
Короб — исключение: его ширина полосы зависит от ДВУХ чисел профиля
(ширина+глубина), которые есть только здесь, в тексте названия при
разборе погонажного наряда — поэтому для короба strip_width_mm
считается прямо тут и идёт вместе со строкой, а не через
calc_default_strip_width (той хватает одного width_mm).

Разбор устроен в два слоя: parse_naryad_grid/parse_pogonazh_grid — чистые
функции над готовой сеткой ячеек (тестируются без реального .xls-файла),
parse_naryad_xls_bytes — тонкая обёртка, читающая .xls через xlrd,
передающая сетку дальше и пробующая оба вида по очереди. Колонки таблицы
деталей определяются по тексту заголовков, а не по фиксированным
номерам — печатные формы этой ERP используют неодинаковую раскладку
колонок между файлами."""

import re
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

# Погонажный наряд не даёт отдельных колонок ширина/длина — они зашиты в
# текст названия вторым и третьим числом ("Добор телескоп 10х100х2070" —
# 100 ширина, 2070 длина; первое число — не всегда толщина в привычном
# смысле, у короба это "глубина" профиля, но порядок тот же на всех
# наблюдавшихся образцах).
POGONAZH_DIMS_RE = re.compile(r"(\d+)\s*[xх]\s*(\d+)\s*[xх]\s*(\d+)")

# Ширина полосы ПВХ для короба МДФ по профилю (ширина_мм, глубина_мм) →
# ширина плёнки_мм — верифицированные константы из
# interior_material_cost.py::KOROB_MDF_PROFILES (короб не входит в
# calc_default_strip_width: там всего один аргумент width_mm, а профиль
# короба неоднозначен по одной лишь ширине — нужны обе цифры).
KOROB_WRAP_WIDTHS_MM: dict[tuple[int, int], float] = {
    (75, 32): 120.0, (70, 32): 115.0, (75, 30): 120.0, (70, 30): 120.0,
    (79, 32): 130.0, (70, 26): 110.0, (78, 26): 120.0,
    (120, 32): 165.0, (140, 32): 185.0, (180, 32): 225.0,
}


@dataclass(frozen=True)
class ParsedNaryadLine:
    part_name: str
    width_mm: float
    length_m: float
    quantity_pieces: float
    strip_width_mm: float | None = None


@dataclass(frozen=True)
class NaryadParseResult:
    suggested_name: str
    lines: list[ParsedNaryadLine] = field(default_factory=list)


def _is_stop_row(row: list) -> bool:
    return any(isinstance(cell, str) and any(marker in cell.strip().lower() for marker in STOP_MARKERS) for cell in row)


def _scan_header_metadata(rows: list[list], stop_row_idx: int) -> tuple[int | None, str | None]:
    """Номер заказа/наряда и название модели/группы — из строк ДО
    таблицы деталей: первое встреченное число (обычно печатается рядом с
    названием модели вверху формы) и первый непустой текст, не считая
    служебных плейсхолдеров формы (см. STOP_MARKERS)."""
    order_number: int | None = None
    model_label: str | None = None
    for row in rows[:stop_row_idx]:
        for cell in row:
            if isinstance(cell, (int, float)) and order_number is None:
                order_number = int(cell)
            elif isinstance(cell, str) and cell.strip() and model_label is None:
                text = cell.strip()
                if text.lower() not in STOP_MARKERS:
                    model_label = text
    return order_number, model_label


def _suggested_name(order_number: int | None, model_label: str | None, fallback: str) -> str:
    name = f"Заказ №{order_number}" if order_number is not None else fallback
    if model_label:
        name += f" — {model_label}"
    return name


def parse_naryad_grid(rows: list[list]) -> NaryadParseResult:
    """Раздел «РАСКЛАДКА» (детали дверного полотна). rows[r][c] — значение
    ячейки (xlrd отдаёт числа как float, текст — как str, пустая ячейка —
    как ""). Поднимает ValueError с понятным сообщением, если структура
    не похожа на такой наряд — вызывающий код (parse_naryad_xls_bytes)
    ловит это и пробует погонажный вид вместо явной ошибки пользователю."""
    header_row_idx: int | None = None
    for r, row in enumerate(rows):
        if any(isinstance(cell, str) and cell.strip().lower() == RASKLADKA_MARKER for cell in row):
            header_row_idx = r
            break

    if header_row_idx is None:
        raise ValueError('Не найден раздел "РАСКЛАДКА" — не похоже на печатную форму наряд-заказа деталей полотна')

    order_number, model_label = _scan_header_metadata(rows, header_row_idx)

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

    return NaryadParseResult(suggested_name=_suggested_name(order_number, model_label, "Наряд-заказ"), lines=lines)


def _korob_strip_width_mm(name: str, depth_mm: float, width_mm: float) -> float | None:
    if "короб" not in name.lower():
        return None
    return KOROB_WRAP_WIDTHS_MM.get((int(width_mm), int(depth_mm)))


def _extract_pogonazh_dims(name: str) -> tuple[float, float, float] | None:
    """(глубина/профильное_число, ширина_мм, длина_мм) из текста названия —
    второе число всегда ширина заготовки, третье — длина; первое ("10" у
    добора, "8" у наличника, "32" у короба) используется только коробом
    (см. _korob_strip_width_mm), для остальных не нужно."""
    match = POGONAZH_DIMS_RE.search(name)
    if not match:
        return None
    depth, width, length = match.groups()
    return float(depth), float(width), float(length)


def parse_pogonazh_grid(rows: list[list]) -> NaryadParseResult:
    """Погонажный наряд (добор/наличник/короб и т.п.) — колонка «Кол-во
    ПЛАН» вместо явных ширины/длины, сами размеры зашиты в текст
    названия ("Добор телескоп 10х100х2070")."""
    header_row_idx: int | None = None
    col_map: dict[str, int] = {}
    for r, row in enumerate(rows):
        found: dict[str, int] = {}
        for c, cell in enumerate(row):
            if not isinstance(cell, str):
                continue
            key = cell.strip().lower()
            if key.startswith("деталь"):
                found["part_name"] = c
            elif "кол-во" in key and "план" in key:
                found["quantity_pieces"] = c
        if {"part_name", "quantity_pieces"} <= found.keys():
            header_row_idx = r
            col_map = found
            break

    if header_row_idx is None:
        raise ValueError('Не найдена таблица погонажных позиций (колонки "Деталь"/"Кол-во ПЛАН")')

    order_number, model_label = _scan_header_metadata(rows, header_row_idx)

    lines: list[ParsedNaryadLine] = []
    for r in range(header_row_idx + 1, len(rows)):
        row = rows[r]
        if _is_stop_row(row):
            break

        def cell(field_name: str):
            idx = col_map[field_name]
            return row[idx] if idx < len(row) else ""

        name, qty = cell("part_name"), cell("quantity_pieces")
        if not isinstance(name, str) or not name.strip():
            continue
        if not isinstance(qty, (int, float)) or qty <= 0:
            continue
        dims = _extract_pogonazh_dims(name)
        if dims is None:
            continue
        depth_mm, width_mm, length_mm = dims
        lines.append(
            ParsedNaryadLine(
                part_name=name.strip(),
                width_mm=width_mm,
                length_m=round(length_mm / 1000, 4),
                quantity_pieces=float(qty),
                strip_width_mm=_korob_strip_width_mm(name, depth_mm, width_mm),
            )
        )

    if not lines:
        raise ValueError('В таблице погонажных позиций не найдено ни одной строки с размерами в названии')

    return NaryadParseResult(suggested_name=_suggested_name(order_number, model_label, "Погонаж"), lines=lines)


def parse_naryad_xls_bytes(data: bytes) -> NaryadParseResult:
    workbook = xlrd.open_workbook(file_contents=data)
    sheet = workbook.sheet_by_index(0)
    grid = [[sheet.cell_value(r, c) for c in range(sheet.ncols)] for r in range(sheet.nrows)]
    try:
        return parse_naryad_grid(grid)
    except ValueError:
        return parse_pogonazh_grid(grid)
