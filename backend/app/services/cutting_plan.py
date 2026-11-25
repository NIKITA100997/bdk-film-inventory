"""План резки одного донора сразу на несколько разных потребностей одной
номенклатуры (раздел про несколько разных ширин штрипса на один день) —
щелевая резка физически режет рулон на несколько полос за один проход,
поэтому если на сегодня нужно несколько разных ширин одной и той же
плёнки, разумнее резать один донор сразу на сколько получится ширин, а
не по одной независимо (как /units/issue делает для одной строки).

Чистые функции без БД (по образцу placement.py/splitting.py) — подбор
делает build_cutting_plan, загрузка кандидатов-доноров — в вызывающем
коде (api/units.py)."""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations


@dataclass(frozen=True)
class DonorCandidate:
    unit_id: int
    width_mm: float
    length_m: float
    days_in_storage: int = 0


@dataclass(frozen=True)
class CuttingPlan:
    donor: DonorCandidate | None
    covered_indices: list[int]
    waste_mm: float


_EXACT_LIMIT = 16


def _greedy_subset(widths: list[float], donor_width: float, min_useful_width_mm: float) -> tuple[list[int], float] | None:
    """Быстрая эвристика для больших пачек (>16 ширин), где полный перебор комбинаций слишком дорог."""
    order = sorted(range(len(widths)), key=lambda i: -widths[i])
    chosen: list[int] = []
    total = 0.0
    for idx in order:
        w = widths[idx]
        if total + w <= donor_width + 1e-9:
            chosen.append(idx)
            total += w
    if not chosen:
        return None
    leftover = donor_width - total
    # Если остался бесполезный обрезок, пробуем убрать последний добавленный элемент, пока остаток не станет допустимым
    while chosen and leftover > 1e-9 and leftover < min_useful_width_mm:
        removed = chosen.pop()
        total -= widths[removed]
        leftover = donor_width - total
    if not chosen:
        return None
    return chosen, max(leftover, 0.0)


def _best_subset(widths: list[float], donor_width: float, min_useful_width_mm: float) -> tuple[list[int], float] | None:
    """Наибольшее по числу покрытых потребностей подмножество (при
    равенстве — минимальный остаток) индексов needed_widths, которое
    помещается в донора и оставляет либо ровно 0, либо остаток не меньше
    min_useful_width_mm (иначе донор оставил бы бесполезный обрезок тоньше
    порога полезной ширины — такое сочетание не предлагаем). None, если
    даже самая узкая потребность не помещается в этого донора."""
    n = len(widths)
    if n > _EXACT_LIMIT:
        return _greedy_subset(widths, donor_width, min_useful_width_mm)
    for size in range(n, 0, -1):
        found: list[tuple[list[int], float]] = []
        for combo in combinations(range(n), size):
            total = sum(widths[i] for i in combo)
            if total > donor_width + 1e-9:
                continue
            leftover = donor_width - total
            if leftover > 1e-9 and leftover < min_useful_width_mm:
                continue
            found.append((list(combo), max(leftover, 0.0)))
        if found:
            return min(found, key=lambda c: c[1])
    return None


def build_cutting_plan(
    needed_widths_mm: list[float], donors: list[DonorCandidate], min_useful_width_mm: float
) -> CuttingPlan:
    """Выбирает донора, который закрывает БОЛЬШЕ всего потребностей одним
    резом (при равенстве — с меньшим отходом, затем — самый старый остаток
    первым, тот же приоритет возраста, что и у одиночной донор-рекомендации
    в /units/issue)."""
    best: CuttingPlan | None = None
    for donor in sorted(donors, key=lambda d: (-d.days_in_storage, d.width_mm)):
        result = _best_subset(needed_widths_mm, donor.width_mm, min_useful_width_mm)
        if result is None:
            continue
        covered, waste = result
        if best is None or (len(covered), -waste) > (len(best.covered_indices), -best.waste_mm):
            best = CuttingPlan(donor=donor, covered_indices=covered, waste_mm=waste)
    return best or CuttingPlan(donor=None, covered_indices=[], waste_mm=0.0)
