from datetime import datetime

from pydantic import BaseModel


class DeleteResultOut(BaseModel):
    """Общий ответ "умных" DELETE-эндпоинтов (раздел про удаление
    сущностей) — суперпользователь удаляет сразу (deleted=true), у
    остальных вместо этого создаётся заявка на удаление (requested=true),
    сама сущность не трогается."""

    deleted: bool
    requested: bool


class DeletionRequestOut(BaseModel):
    id: int
    entity_type: str
    entity_id: int
    entity_label: str
    reason: str | None
    status: str
    requested_by: int
    requested_by_name: str
    created_at: datetime
    resolved_by: int | None
    resolved_at: datetime | None
    resolution_note: str | None


class DeletionRequestReject(BaseModel):
    note: str | None = None
