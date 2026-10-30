"""Сервис аудита изменений ключевых сущностей системы (Audit Trail)."""

from typing import Any
from sqlalchemy.orm import Session
from app.models.audit import EntityAuditLog


def record_audit(
    db: Session,
    entity_type: str,
    entity_id: int,
    action: str,
    changed_fields: dict[str, Any] | None = None,
    user_id: int | None = None,
    user_name: str | None = None,
) -> EntityAuditLog:
    """Запись события в журнал аудита."""
    log_entry = EntityAuditLog(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        changed_fields=changed_fields,
        user_id=user_id,
        user_name=user_name,
    )
    db.add(log_entry)
    db.flush()
    return log_entry


def get_audit_history(
    db: Session,
    entity_type: str,
    entity_id: int,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Получение истории изменений конкретного объекта."""
    entries = (
        db.query(EntityAuditLog)
        .filter(
            EntityAuditLog.entity_type == entity_type,
            EntityAuditLog.entity_id == entity_id,
        )
        .order_by(EntityAuditLog.created_at.desc())
        .limit(limit)
        .all()
    )

    return [
        {
            "id": e.id,
            "entity_type": e.entity_type,
            "entity_id": e.entity_id,
            "action": e.action,
            "changed_fields": e.changed_fields,
            "user_id": e.user_id,
            "user_name": e.user_name,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in entries
    ]
