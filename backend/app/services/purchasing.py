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
