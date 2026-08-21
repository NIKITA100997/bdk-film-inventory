"""Сверка живых сигналов с персистентной историей уведомлений (раздел 16
бэклога доработок) — без фонового планировщика: GET /notifications сам
пересчитывает текущий набор сигналов (переиспользует уже существующую
get_stale_units) и сверяет с уже сохранёнными открытыми записями, заводя
новые и закрывая пропавшие. Чистая функция сверки вынесена отдельно от
эндпоинта (доступ к БД) для юнит-тестов, тот же паттерн, что и
services/purchasing.py::requests_closed_by_receipt."""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class OpenNotification:
    id: int
    entity_id: int


@dataclass(frozen=True)
class ReconcileResult:
    to_insert: list[int] = field(default_factory=list)  # entity_id'ы новых сигналов
    to_resolve: list[int] = field(default_factory=list)  # id уведомлений, которые пора закрыть


def reconcile_stale_unit_notifications(
    existing_open: list[OpenNotification], current_entity_ids: set[int]
) -> ReconcileResult:
    existing_by_entity = {n.entity_id: n.id for n in existing_open}
    to_insert = [entity_id for entity_id in current_entity_ids if entity_id not in existing_by_entity]
    to_resolve = [
        notification_id for entity_id, notification_id in existing_by_entity.items() if entity_id not in current_entity_ids
    ]
    return ReconcileResult(to_insert=to_insert, to_resolve=to_resolve)
