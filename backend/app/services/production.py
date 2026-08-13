"""Раздел про распределение по линиям и брак в производстве — чистые
функции остатка строки задания, вынесены отдельно от эндпоинта (доступ к
БД) для юнит-тестов, тот же паттерн, что services/purchasing.py::
requests_closed_by_receipt и services/suppliers.py::compute_supplier_stats."""


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


def compute_expected_return_length_m(
    issued_length_m: float, length_m_per_piece: float, good_pieces: float, defect_pieces: float
) -> float:
    """Ожидаемая длина остатка при возврате (раздел про возврат остатка) —
    хорошие и бракованные детали одинаково списывают полную длину детали
    из выданной длины (брак тоже расходует плёнку, просто не идёт в
    готовое изделие). Не уходит в минус, если факт производства почему-то
    превысил выданную длину."""
    return max(0.0, issued_length_m - length_m_per_piece * (good_pieces + defect_pieces))
