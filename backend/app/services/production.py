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


def calc_default_strip_width(part_name: str | None, width_mm: float) -> float:
    """Дефолтная ширина штрипса под укутку по названию детали, когда
    strip_width_mm не задан явно ни на детали BOM, ни на строке задания
    (раздел про размер штрипса) — используется и при выводе моделей/
    заданий, и при строгой проверке соответствия плёнки на выдаче
    (units.py)."""
    if not part_name:
        return width_mm
    name_lower = part_name.lower()
    if "стоевая" in name_lower:
        return 292.0
    if "поперечная" in name_lower:
        return 285.0
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
