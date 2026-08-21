"""Закупки (5.5 ТЗ) — авто-закрытие заявки снабженцу приёмкой той же группы
материал+цвет+толщина. Чистая функция сопоставления вынесена отдельно от
`auto_close_on_receipt` (обёртка с доступом к БД) для юнит-тестов."""

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.purchasing import PurchaseRequest


@dataclass(frozen=True)
class OpenRequestGroup:
    id: int
    material_id: int
    color_id: int
    thickness_id: int


def requests_closed_by_receipt(
    open_requests: list[OpenRequestGroup], *, material_id: int, color_id: int, thickness_id: int
) -> list[int]:
    return [
        r.id
        for r in open_requests
        if (r.material_id, r.color_id, r.thickness_id) == (material_id, color_id, thickness_id)
    ]


def auto_close_on_receipt(db: Session, *, material_id: int, color_id: int, thickness_id: int) -> int:
    open_reqs = db.query(PurchaseRequest).filter(PurchaseRequest.status == "open").all()
    groups = [OpenRequestGroup(r.id, r.material_id, r.color_id, r.thickness_id) for r in open_reqs]
    ids_to_close = set(
        requests_closed_by_receipt(groups, material_id=material_id, color_id=color_id, thickness_id=thickness_id)
    )
    if not ids_to_close:
        return 0
    now = datetime.now(timezone.utc)
    for r in open_reqs:
        if r.id in ids_to_close:
            r.status = "closed"
            r.closed_at = now
    return len(ids_to_close)


@dataclass(frozen=True)
class ReorderInput:
    """Точка дозаказа по расходу (раздел про закупки на опережение) —
    вход на одну группу материал+цвет+толщина."""

    current_stock_m2: float
    consumed_m2_in_window: float  # выдачи+списания за reorder_lookback_days
    lookback_days: int
    avg_lead_time_days: float | None  # None — по этой группе ещё не было закрытых заявок с поставщиком
    safety_margin_days: int


@dataclass(frozen=True)
class ReorderSignal:
    days_of_stock_remaining: float | None  # None — расхода не было, делить не на что
    reorder_suggested: bool


def compute_reorder_signal(inp: ReorderInput) -> ReorderSignal:
    if inp.consumed_m2_in_window <= 0:
        # Расхода не было за окно — "хватит на N дней" тут ложный сигнал
        # ("хватит бесконечно"), а не полезная подсказка.
        return ReorderSignal(days_of_stock_remaining=None, reorder_suggested=False)
    daily_rate = inp.consumed_m2_in_window / inp.lookback_days
    days_remaining = inp.current_stock_m2 / daily_rate
    # Без истории закрытых заявок с поставщиком по этой группе — не с чем
    # сравнивать "успеем ли довезти", не гадаем на пустом месте.
    reorder_suggested = inp.avg_lead_time_days is not None and days_remaining <= (
        inp.avg_lead_time_days + inp.safety_margin_days
    )
    return ReorderSignal(days_of_stock_remaining=round(days_remaining, 1), reorder_suggested=reorder_suggested)
