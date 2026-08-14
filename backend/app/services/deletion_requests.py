"""Заявки на удаление (раздел про удаление сущностей) — если для той же
(entity_type, entity_id) уже есть pending-заявка, не плодим дубликаты:
несколько сотрудников могут независимо нажать "запросить удаление" на
одну и ту же запись."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.deletion_requests import DeletionRequest


def request_deletion(
    db: Session, *, entity_type: str, entity_id: int, entity_label: str, requested_by: int, reason: str | None = None
) -> DeletionRequest:
    existing = (
        db.query(DeletionRequest)
        .filter(
            DeletionRequest.entity_type == entity_type,
            DeletionRequest.entity_id == entity_id,
            DeletionRequest.status == "pending",
        )
        .first()
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Уже отправлено на удаление — ждите решения администратора",
        )
    req = DeletionRequest(
        entity_type=entity_type,
        entity_id=entity_id,
        entity_label=entity_label,
        reason=reason,
        requested_by=requested_by,
    )
    db.add(req)
    return req
