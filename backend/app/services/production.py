"""Разбор производственного задания на строки по линиям (пилот: окутка
царговых) — «сделать N штук модели X» превращается в «линия — плёнка —
количество деталей». Чистая функция разбора вынесена отдельно от
эндпоинта (доступ к БД) для юнит-тестов, тот же паттерн, что
services/purchasing.py::requests_closed_by_receipt и
services/suppliers.py::compute_supplier_stats."""

from dataclasses import dataclass


@dataclass(frozen=True)
class BomPart:
    line_id: int
    material_id: int
    color_id: int
    thickness_id: int
    qty_per_unit: float
    width_mm: float
    length_m: float


@dataclass(frozen=True)
class TaskLineResult:
    line_id: int
    material_id: int
    color_id: int
    thickness_id: int
    width_mm: float
    length_m: float
    quantity_pieces: float


def explode_task(parts: list[BomPart], quantity: int) -> list[TaskLineResult]:
    """Разворачивает 'N штук модели X' в задания по линиям — группирует по
    (линия, материал, цвет, толщина, ширина, длина): несколько деталей
    модели могут использовать одну и ту же линию, плёнку И размер куска,
    тогда складываем в одну строку (ровно так, как задание видит начальник
    участка). Размер входит в ключ группировки — деталь того же цвета, но
    другого размера реза, это другая заготовка, её нельзя смешивать в одно
    quantity_pieces с другой."""
    totals: dict[tuple[int, int, int, int, float, float], float] = {}
    for p in parts:
        key = (p.line_id, p.material_id, p.color_id, p.thickness_id, p.width_mm, p.length_m)
        totals[key] = totals.get(key, 0.0) + p.qty_per_unit * quantity
    return [
        TaskLineResult(
            line_id=line_id,
            material_id=material_id,
            color_id=color_id,
            thickness_id=thickness_id,
            width_mm=width_mm,
            length_m=length_m,
            quantity_pieces=qty,
        )
        for (line_id, material_id, color_id, thickness_id, width_mm, length_m), qty in totals.items()
    ]


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
