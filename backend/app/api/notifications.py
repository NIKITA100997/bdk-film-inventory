from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.reports import stale_units
from app.core.security import require_permission
from app.db.session import get_db
from app.models.notifications import Notification
from app.models.users import User
from app.schemas.notifications import NotificationOut
from app.services.notifications import OpenNotification, reconcile_stale_unit_notifications

router = APIRouter(prefix="/notifications", tags=["notifications"])

view_notifications = require_permission("reports.view")

STALE_UNIT_SIGNAL = "stale_unit"


@router.get("", response_model=list[NotificationOut])
def list_notifications(db: Session = Depends(get_db), user: User = Depends(view_notifications)) -> list[NotificationOut]:
    """Персистентная история уведомлений (раздел 16 бэклога доработок) —
    сверяет текущий набор живых сигналов "давно не двигалось" (та же
    stale_units) с уже сохранёнными открытыми записями при каждом вызове
    (тот же поллинг, что уже есть у колокольчика, без отдельного
    планировщика): заводит новые, закрывает пропавшие."""
    stale = stale_units(threshold_days=None, db=db, user=user)
    current_entity_ids = {u.unit_id for u in stale}

    existing_open = (
        db.query(Notification)
        .filter(Notification.signal_type == STALE_UNIT_SIGNAL, Notification.resolved_at.is_(None))
        .all()
    )
    result = reconcile_stale_unit_notifications(
        [OpenNotification(id=n.id, entity_id=n.entity_id) for n in existing_open], current_entity_ids
    )

    stale_by_unit = {u.unit_id: u for u in stale}
    for entity_id in result.to_insert:
        u = stale_by_unit[entity_id]
        db.add(
            Notification(
                signal_type=STALE_UNIT_SIGNAL,
                entity_id=entity_id,
                title=f"№{u.unit_id} — {u.material}, {u.color}",
                detail=f"Давно не двигалось — {u.days_idle} дн.",
            )
        )
    if result.to_resolve:
        now = datetime.now(timezone.utc)
        db.query(Notification).filter(Notification.id.in_(result.to_resolve)).update(
            {"resolved_at": now}, synchronize_session=False
        )
    db.commit()

    open_notifications = (
        db.query(Notification)
        .filter(Notification.signal_type == STALE_UNIT_SIGNAL, Notification.resolved_at.is_(None))
        .order_by(Notification.first_seen_at.desc())
        .all()
    )
    return [
        NotificationOut(
            id=n.id,
            signal_type=n.signal_type,
            entity_id=n.entity_id,
            title=n.title,
            detail=n.detail,
            first_seen_at=n.first_seen_at,
            read_at=n.read_at,
            is_new=n.entity_id in result.to_insert,
        )
        for n in open_notifications
    ]


@router.post("/{notification_id}/read", response_model=NotificationOut)
def mark_notification_read(
    notification_id: int, db: Session = Depends(get_db), user: User = Depends(view_notifications)
) -> NotificationOut:
    n = db.get(Notification, notification_id)
    if n is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Уведомление не найдено")
    n.read_at = datetime.now(timezone.utc)
    n.read_by = user.id
    db.commit()
    db.refresh(n)
    return NotificationOut(
        id=n.id,
        signal_type=n.signal_type,
        entity_id=n.entity_id,
        title=n.title,
        detail=n.detail,
        first_seen_at=n.first_seen_at,
        read_at=n.read_at,
        is_new=False,
    )
