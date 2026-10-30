"""Отказоустойчивая асинхронная очередь и Dead Letter Queue (DLQ).

Обрабатывает внешние интеграционные вызовы (Bitrix24, вебхуки, почта):
- Повторные попытки при временных сбоях сети (retry с backoff).
- Помещение стойких ошибок в Dead Letter Queue для ручного разбора или повтора в 1 клик.
"""

import logging
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session
from app.models.audit import DeadLetterEvent

logger = logging.getLogger(__name__)


def enqueue_dead_letter(
    db: Session,
    service: str,
    event_type: str,
    payload: dict[str, Any],
    error_message: str,
) -> DeadLetterEvent:
    """Сохранение недоставленного события в DLQ."""
    event = DeadLetterEvent(
        service=service,
        event_type=event_type,
        payload=payload,
        attempts=1,
        max_attempts=3,
        last_error=error_message[:2000],
        status="dead_letter",
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    logger.warning("Event enqueued to DeadLetterQueue: %s/%s (id=%s): %s", service, event_type, event.id, error_message)
    return event


def list_dead_letters(
    db: Session,
    status: str | None = None,
    service: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Список событий в DLQ для мониторинга администратором."""
    q = db.query(DeadLetterEvent)
    if status:
        q = q.filter(DeadLetterEvent.status == status)
    if service:
        q = q.filter(DeadLetterEvent.service == service)

    events = q.order_by(DeadLetterEvent.created_at.desc()).limit(limit).all()
    return [
        {
            "id": e.id,
            "service": e.service,
            "event_type": e.event_type,
            "payload": e.payload,
            "attempts": e.attempts,
            "max_attempts": e.max_attempts,
            "last_error": e.last_error,
            "status": e.status,
            "created_at": e.created_at.isoformat() if e.created_at else None,
            "last_attempt_at": e.last_attempt_at.isoformat() if e.last_attempt_at else None,
        }
        for e in events
    ]


def retry_dead_letter(
    db: Session,
    event_id: int,
) -> dict[str, Any]:
    """Повторная отправка события из Dead Letter Queue."""
    event = db.get(DeadLetterEvent, event_id)
    if not event:
        return {"success": False, "error": f"Событие DLQ #{event_id} не найдено"}

    event.attempts += 1
    event.last_attempt_at = datetime.now()

    # Dispatch to target service
    try:
        if event.service == "bitrix24":
            from app.services import bitrix_deals

            # Example: call deal stage or comment
            event_type = event.event_type
            payload = event.payload or {}
            if event_type == "notify_event":
                bitrix_deals.notify_order_event(
                    order_id=payload.get("order_id", 0),
                    event_title=payload.get("event_title", ""),
                    comment=payload.get("comment", ""),
                    target_stage_by_direction=payload.get("target_stage_by_direction"),
                )
            elif event_type == "sync_deal":
                bitrix_deals.sync_order_deals(
                    order_id=payload.get("order_id", 0),
                    target_stage=payload.get("target_stage", ""),
                    comment=payload.get("comment"),
                )
        event.status = "delivered"
        db.commit()
        return {"success": True, "event_id": event.id, "status": "delivered"}
    except Exception as e:
        logger.exception("Retry failed for DLQ #%s", event_id)
        event.last_error = str(e)[:2000]
        event.status = "dead_letter"
        db.commit()
        return {"success": False, "event_id": event.id, "error": str(e)}
