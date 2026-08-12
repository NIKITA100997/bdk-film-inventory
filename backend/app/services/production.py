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


@dataclass(frozen=True)
class TaskLineResult:
    line_id: int
    material_id: int
    color_id: int
    thickness_id: int
    quantity_pieces: float


def explode_task(parts: list[BomPart], quantity: int) -> list[TaskLineResult]:
    """Разворачивает 'N штук модели X' в задания по линиям — группирует по
    (линия, материал, цвет, толщина): несколько деталей модели могут
    использовать одну и ту же линию и плёнку, тогда складываем в одну
    строку (ровно так, как задание видит начальник участка — не по
    деталям, а по линии+цвету)."""
    totals: dict[tuple[int, int, int, int], float] = {}
    for p in parts:
        key = (p.line_id, p.material_id, p.color_id, p.thickness_id)
        totals[key] = totals.get(key, 0.0) + p.qty_per_unit * quantity
    return [
        TaskLineResult(line_id=line_id, material_id=material_id, color_id=color_id, thickness_id=thickness_id, quantity_pieces=qty)
        for (line_id, material_id, color_id, thickness_id), qty in totals.items()
    ]
