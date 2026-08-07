"""Логика сопоставления скана с ожидаемым адресом (6.8 ТЗ) — чистая функция,
без обращения к БД, чтобы протестировать отдельно от HTTP-слоя, как и
services/splitting.py."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class ScanMatchKind(str, Enum):
    CONFIRMED = "confirmed"  # на месте, всё сходится
    MOVED = "moved"  # есть в системе, но не по адресу


@dataclass
class ScanMatch:
    kind: ScanMatchKind
    from_cell: str | None
    to_cell: str


def match_scan(existing_location_code: str | None, scanned_location_code: str) -> ScanMatch:
    """Единица уже есть в системе (найдена по ID) — сравниваем адрес по
    учёту с адресом, где её физически отсканировали."""
    if existing_location_code == scanned_location_code:
        return ScanMatch(kind=ScanMatchKind.CONFIRMED, from_cell=existing_location_code, to_cell=scanned_location_code)
    return ScanMatch(kind=ScanMatchKind.MOVED, from_cell=existing_location_code, to_cell=scanned_location_code)


def resolve_participant_ids(started_by: int, requested_participant_ids: list[int]) -> list[int]:
    """Состав бригады сессии (5.4 ТЗ: "создание сессии (область,
    участники)") — ответственный всегда в списке, даже если не указал себя
    явно; порядок сохраняется, дубли убираются."""
    ordered = [started_by, *requested_participant_ids]
    seen: set[int] = set()
    result: list[int] = []
    for user_id in ordered:
        if user_id not in seen:
            seen.add(user_id)
            result.append(user_id)
    return result
