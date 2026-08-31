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

import difflib
import re
from dataclasses import dataclass, field, replace

import xlrd
from sqlalchemy.orm import Session

from app.models.dictionaries import Part

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
    # Раздел про соответствие деталям у наряд-заказа (enrich_naryad_lines
    # ниже) — id найденной в справочнике детали, если совпадение
    # уверенное (по категории+размерам); None — совпадения не нашлось,
    # ширина штрипса досчитается позже calc_default_strip_width как и
    # раньше.
    suggested_part_id: int | None = None


@dataclass(frozen=True)
class NaryadParseResult:
    suggested_name: str
    lines: list[ParsedNaryadLine] = field(default_factory=list)
    # Тот же номер, что уже вклеен текстом в suggested_name ("Заказ №8842") —
    # но отдельным полем, для production_tasks.external_order_ref.
    order_number: int | None = None


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

    return NaryadParseResult(
        suggested_name=_suggested_name(order_number, model_label, "Наряд-заказ"), lines=lines, order_number=order_number
    )


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

    return NaryadParseResult(
        suggested_name=_suggested_name(order_number, model_label, "Погонаж"), lines=lines, order_number=order_number
    )


def parse_naryad_xls_bytes(data: bytes) -> NaryadParseResult:
    workbook = xlrd.open_workbook(file_contents=data)
    sheet = workbook.sheet_by_index(0)
    grid = [[sheet.cell_value(r, c) for c in range(sheet.ncols)] for r in range(sheet.nrows)]
    try:
        return parse_naryad_grid(grid)
    except ValueError:
        return parse_pogonazh_grid(grid)


# Раздел про соответствие деталям у наряд-заказа — те же категории, что
# уже узнаёт calc_default_strip_width по ключевому слову в названии
# (services/production.py), но здесь категория используется не для
# формулы, а чтобы сузить поиск по справочнику деталей до нужной группы.
_NAME_CATEGORIES = ("стоевая", "поперечная", "филенка", "наличник", "добор", "планка", "короб")
_WIDTH_TOLERANCE_MM = 2.0
_LENGTH_TOLERANCE_M = 0.005


def _detect_category(name_lower: str) -> str | None:
    if "филёнка" in name_lower:
        return "филенка"
    for category in _NAME_CATEGORIES:
        if category in name_lower:
            return category
    return None


_NAME_MATCH_CUTOFF = 0.6
# Скобочные группы в тексте названия наряд-заказа — цвет дерева/МДФ
# ("(Капучино)") и/или маркер "(МежКомн)" (реальный образец:
# "Поперечная (МежКомн) 30х110х504 (Капучино) ПАЗ-11"), ни того ни
# другого нет в справочнике деталей (там голое "Поперечная 30х110х1840
# ПАЗ-11") — убираем целиком перед сравнением, иначе шум сбивает
# коэффициент похожести. Профиль паза в реальных образцах всегда идёт
# отдельным текстом без скобок ("ПАЗ-11"), поэтому его не задевает.
_PAREN_NOISE_RE = re.compile(r"\([^()]*\)")


def _normalize_for_match(name: str) -> str:
    return re.sub(r"\s+", " ", _PAREN_NOISE_RE.sub("", name)).strip().lower()


def _match_catalog_part(parts_by_category: dict[str, list[Part]], name: str, width_mm: float, length_m: float) -> Part | None:
    """Раздел про соответствие деталям (справочник) — категория по
    ключевому слову + совпадение ширины детали (дерево/МДФ) с точностью
    до допуска сужает поиск до кандидатов той же ширины. Дальше — по
    убыванию надёжности:
    1) точный/близкий текст названия (сработает для погонажа —
       "Добор"/"Наличник"/"Планка"/короб несут в тексте профиль паза,
       "ПАЗ-4" и т.п. — то же самое, что уже есть в справочнике);
    2) если у всех кандидатов той же ширины одна и та же ширина штрипса —
       профиль паза не виден в разделе РАСКЛАДКА (голое "Стоевая"/
       "Поперечная"/"Филёнка", без текста паза), но раз они все дают один
       и тот же результат, не важно, какой конкретно паз — берём любой;
    3) длина — последний рубеж, если по названию/ширине штрипса не
       разрешилось (у некоторых позиций справочника length_m не совпадает
       с тем, что написано в самом названии — не самый надёжный сигнал,
       поэтому проверяется последним, не первым).
    Если ни один способ не дал однозначности — не гадаем, оставляем
    пусто (тот же принцип, что и у плана заготовок: без уверенности
    лучше оставить для ручного выбора, чем подставить не то)."""
    category = _detect_category(name.lower())
    if category is None:
        return None
    width_matches = [p for p in parts_by_category.get(category, []) if abs(float(p.width_mm) - width_mm) <= _WIDTH_TOLERANCE_MM]
    if not width_matches:
        return None

    by_lower_name = {p.name.strip().lower(): p for p in width_matches}
    name_match = difflib.get_close_matches(_normalize_for_match(name), list(by_lower_name), n=1, cutoff=_NAME_MATCH_CUTOFF)
    if name_match:
        return by_lower_name[name_match[0]]

    distinct_strips = {float(p.strip_width_mm) for p in width_matches if p.strip_width_mm is not None}
    if len(distinct_strips) == 1:
        return width_matches[0]

    length_matches = [p for p in width_matches if abs(float(p.length_m) - length_m) <= _LENGTH_TOLERANCE_M]
    return length_matches[0] if len(length_matches) == 1 else None


def enrich_naryad_lines(db: Session, result: NaryadParseResult) -> NaryadParseResult:
    """Раздел про соответствие деталям у наряд-заказа — раньше загрузчик
    вообще не смотрел в справочник деталей (в отличие от плана заготовок,
    services.blank_plan_import.enrich_blank_plan_blocks), поэтому ширина
    штрипса всегда шла через грубую calc_default_strip_width (одна
    формула на ключевое слово, без учёта конкретной модели/паза — для
    "планки", например, она даёт фиксированные 140/100 мм, тогда как в
    реальном справочнике ширина штрипса планки скачет от 25 до 188 мм в
    зависимости от модели), и совпадение с деталью никогда не
    проставлялось. Здесь — то же сопоставление по духу, что у плана
    заготовок, но по размерам, не по нечёткому тексту (см.
    _match_catalog_part): найденное совпадение даёт точную ширину
    штрипса из справочника вместо формулы; не найденное — всё остаётся
    как раньше, calc_default_strip_width досчитает как запасной
    вариант."""
    parts = db.query(Part).filter(Part.is_active).all()
    parts_by_category: dict[str, list[Part]] = {}
    for p in parts:
        category = _detect_category(p.name.lower())
        if category:
            parts_by_category.setdefault(category, []).append(p)

    enriched_lines = []
    for line in result.lines:
        part = _match_catalog_part(parts_by_category, line.part_name, line.width_mm, line.length_m)
        if part is not None and part.strip_width_mm is not None:
            enriched_lines.append(replace(line, strip_width_mm=float(part.strip_width_mm), suggested_part_id=part.id))
        else:
            enriched_lines.append(line)
    return replace(result, lines=enriched_lines)
