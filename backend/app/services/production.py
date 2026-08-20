"""Раздел про распределение по линиям и брак в производстве — чистые
функции остатка строки задания, вынесены отдельно от эндпоинта (доступ к
БД) для юнит-тестов, тот же паттерн, что services/purchasing.py::
requests_closed_by_receipt и services/suppliers.py::compute_supplier_stats."""

from dataclasses import dataclass


def compute_remaining_pieces(quantity_pieces: float, produced_good_pieces: float) -> float:
    """Остаток строки задания (раздел про брак в производстве) — цель
    (quantity_pieces) не мутируется, отчёты о браке лишь снижают
    "засчитанное" произведённое количество; не уходит в минус при
    перевыполнении (несколько отчётов, суммарно давших больше, чем
    требовалось)."""
    return max(0.0, quantity_pieces - produced_good_pieces)


def compute_remaining_length_m(length_m: float, remaining_pieces: float) -> float:
    """Остаток строки задания в метрах плёнки (раздел про размер детали) —
    remaining_pieces уже учитывает произведённое/брак, просто переводим
    остаток из штук в метры через длину одной детали. Округляем до см —
    без этого умножение float даёт "124.19999999999999 м" на экране."""
    return round(length_m * remaining_pieces, 2)


def compute_shortfall_length_m(quantity_pieces: float, length_m: float, defect_pieces: float, issued_length_m: float) -> float:
    """Сколько ещё нужно довыдать по строке задания (раздел про очередь
    «потребности» на выдаче участку) — по факту нехватки уже выданной
    плёнки, а не по голому остатку штук (remaining_pieces): пока выдано
    достаточно на весь план (quantity_pieces), строка не висит в очереди,
    даже если производство ещё не отчиталось о готовых деталях — это
    отдельно видно в списке "Выдано по заданиям". Брак расходует плёнку
    сверх исходного плана (не учтён в quantity_pieces), поэтому именно
    отчёт о браке — единственное, что открывает довыдачу заново."""
    total_needed_length_m = (quantity_pieces + defect_pieces) * length_m
    return max(0.0, round(total_needed_length_m - issued_length_m, 2))


# Раздел про загрузку наряд-заказа — width_mm строки задания хранит
# СОБСТВЕННУЮ ширину детали (дерево/МДФ-заготовка), не ширину плёнки:
# наряд-заказ даёт именно её, а не размер плёнки на укутку (пользователь
# поправил после первой версии загрузчика). Ширина плёнки для филёнки/
# наличника/добора — верифицированные константы из формул проекта
# C:\Users\User\Downloads\Calc (interior_material_cost.py:
# _filenka_items/_nalichnik_items/_dobor_items) — фиксированные, не
# производная от толщины+ширины по общей геометрической формуле.
FILENKA_WOOD_TO_FILM_WIDTH_MM = {163: 356, 220: 474}  # М-1/М-13 и М-11
# Отношение "ширина плёнки / ширина заготовки" у подтверждённых моделей
# (356/163≈2.18, 474/220≈2.15) — среднее, для филёнок с шириной вне
# каталога выше (запасной вариант, точность не подтверждена).
FILENKA_WIDTH_RATIO_FALLBACK = 2.17


def calc_default_strip_width(part_name: str | None, width_mm: float) -> float:
    """Дефолтная ширина штрипса под укутку по названию детали, когда
    strip_width_mm не задан явно ни на детали BOM, ни на строке задания
    (раздел про размер штрипса) — используется и при выводе моделей/
    заданий, и при строгой проверке соответствия плёнки на выдаче
    (units.py). Короб — не здесь: ширина его полосы зависит от ДВУХ чисел
    профиля (ширина+глубина), не выводится из одного width_mm — см.
    services/naryad_import.py::_korob_strip_width_mm (там же, где есть обе
    цифры из текста названия при разборе погонажного наряда)."""
    if not part_name:
        return width_mm
    name_lower = part_name.lower()
    if "стоевая" in name_lower:
        return 292.0
    if "поперечная" in name_lower:
        return 285.0
    if "филенка" in name_lower or "филёнка" in name_lower:
        known = FILENKA_WOOD_TO_FILM_WIDTH_MM.get(round(width_mm))
        return float(known) if known is not None else round(width_mm * FILENKA_WIDTH_RATIO_FALLBACK, 1)
    if "наличник" in name_lower:
        return 120.0
    if "добор" in name_lower:
        return width_mm + 17.0
    if "планка" in name_lower:
        return 140.0 if width_mm >= 40 else 100.0
    return width_mm


@dataclass(frozen=True)
class TaskLineForReserve:
    material_id: int
    color_id: int
    thickness_id: int
    quantity_pieces: float
    produced_good_pieces: float
    length_m: float
    effective_strip_width_mm: float


def reserved_area_m2_by_group(lines: list[TaskLineForReserve]) -> dict[tuple[int, int, int], float]:
    """Резерв на текущие (незавершённые) задания цеха — раздел про экран
    снабженца ("Остатки и резерв"): сколько плёнки ещё не произведено по
    каждой группе материал+цвет+толщина, суммарно по всем строкам заданий.
    Та же арифметика, что уже считает "Выдача участку" для нехватки по
    одной строке (ширина штрипса × остаток по длине), только
    просуммированная по всем открытым строкам сразу, а не по одной —
    "недельный план" в заданиях цеха это только подпись вкладки, дат в
    самих заданиях нет, остаток и так означает "ещё не произведено"."""
    totals: dict[tuple[int, int, int], float] = {}
    for line in lines:
        remaining_pieces = compute_remaining_pieces(line.quantity_pieces, line.produced_good_pieces)
        if remaining_pieces <= 0:
            continue
        remaining_length_m = compute_remaining_length_m(line.length_m, remaining_pieces)
        area_m2 = line.effective_strip_width_mm / 1000 * remaining_length_m
        key = (line.material_id, line.color_id, line.thickness_id)
        totals[key] = totals.get(key, 0.0) + area_m2
    return {key: round(value, 3) for key, value in totals.items()}


def compute_expected_return_length_m(
    issued_length_m: float, length_m_per_piece: float, good_pieces: float, defect_pieces: float
) -> float:
    """Ожидаемая длина остатка при возврате (раздел про возврат остатка) —
    хорошие и бракованные детали одинаково списывают полную длину детали
    из выданной длины (брак тоже расходует плёнку, просто не идёт в
    готовое изделие). Не уходит в минус, если факт производства почему-то
    превысил выданную длину."""
    return max(0.0, issued_length_m - length_m_per_piece * (good_pieces + defect_pieces))


# --- Раздел про «Заготовки» — резать в ширину заранее, до того как задания ---
# --- реально распределены по дням/линиям и за ними «пришли» -------------------


@dataclass
class BlankDemandInputLine:
    """Одна строка задания, посчитанная в потребность на нарезку заготовок
    — GROUP BY делается в Python (aggregate_blank_demand), не в SQL: та
    же ширина штрипса может встречаться в разных заданиях/моделях, а
    считать нужно суммарно, независимо от того, распределена ли строка
    уже по линиям/дням (в отличие от очереди "Выдача участку", которая
    видит только уже распределённое на сегодня/неделю)."""

    material_id: int
    color_id: int
    thickness_id: int
    strip_width_mm: float
    shortfall_length_m: float


@dataclass
class BlankSupplyInputLine:
    """Один рулон/штрипс на хранении, ещё не привязанный ни к одной строке
    задания (production_task_line_id IS NULL) — структурно это и есть
    "заготовка": нарезан заранее, ждёт, когда придёт задание нужной
    ширины."""

    material_id: int
    color_id: int
    thickness_id: int
    width_mm: float
    length_m: float


@dataclass
class BlankDemandRow:
    material_id: int
    color_id: int
    thickness_id: int
    width_mm: float
    needed_length_m: float
    on_hand_length_m: float
    deficit_length_m: float


def aggregate_blank_demand(
    demand: list[BlankDemandInputLine], supply: list[BlankSupplyInputLine]
) -> list[BlankDemandRow]:
    """Сводит потребность (сумма shortfall_length_m по всем активным
    строкам заданий этой позиции+ширины) и наличие (сумма length_m уже
    нарезанных, никому не назначенных заготовок) в одну таблицу —
    deficit_length_m > 0 значит "надо резать ещё", < 0 — уже есть запас
    сверх текущей потребности. Строки без потребности, но с запасом
    (простаивающие заготовки) тоже попадают в список — для видимости, не
    только дефицит; сортировка по убыванию дефицита, чтобы самое срочное
    было сверху."""
    needed: dict[tuple[int, int, int, float], float] = {}
    for d in demand:
        key = (d.material_id, d.color_id, d.thickness_id, d.strip_width_mm)
        needed[key] = needed.get(key, 0.0) + d.shortfall_length_m

    on_hand: dict[tuple[int, int, int, float], float] = {}
    for s in supply:
        key = (s.material_id, s.color_id, s.thickness_id, s.width_mm)
        on_hand[key] = on_hand.get(key, 0.0) + s.length_m

    rows = []
    for key in set(needed) | set(on_hand):
        material_id, color_id, thickness_id, width_mm = key
        n = needed.get(key, 0.0)
        h = on_hand.get(key, 0.0)
        rows.append(
            BlankDemandRow(
                material_id=material_id,
                color_id=color_id,
                thickness_id=thickness_id,
                width_mm=width_mm,
                needed_length_m=round(n, 2),
                on_hand_length_m=round(h, 2),
                deficit_length_m=round(n - h, 2),
            )
        )
    rows.sort(key=lambda r: r.deficit_length_m, reverse=True)
    return rows
