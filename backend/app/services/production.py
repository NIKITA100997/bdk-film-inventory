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
    остаток из штук в метры через длину одной детали."""
    return length_m * remaining_pieces
