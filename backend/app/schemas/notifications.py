from datetime import datetime

from pydantic import BaseModel, ConfigDict


class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    signal_type: str
    entity_id: int
    title: str
    detail: str | None
    first_seen_at: datetime
    read_at: datetime | None
    # Не видел ни разу с момента появления — для подсветки в списке
    # отдельно от общего бейджа "непрочитанных" на самом колокольчике.
    is_new: bool
