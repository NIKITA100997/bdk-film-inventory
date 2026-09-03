from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.part_units import PartUnitStatus


class PartUnitCreate(BaseModel):
    """Регистрация партии начальником цеха (раздел про физический учёт
    деталей) — квант работы: один вызов = одна нарезанная партия. issue_to_area
    — сразу выдать участку (обычно уже известно, для чего нарезали), иначе
    партия остаётся "На_хранении" до отдельной выдачи."""

    part_id: int
    quantity_pieces: float = Field(gt=0)
    production_task_line_id: int | None = None
    issue_to_area: str | None = None
    note: str | None = None


class PartUnitIssue(BaseModel):
    area: str


class PartUnitWriteOff(BaseModel):
    quantity_pieces: float = Field(gt=0)
    reason: str
    note: str | None = None


class PartUnitOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    parent_id: int | None
    part_id: int
    part_name: str
    quantity_pieces: float
    stage_id: int
    stage_name: str
    status: PartUnitStatus
    area: str | None
    location_code: str | None
    production_task_line_id: int | None
    note: str | None
    created_by: int
    created_at: datetime
    updated_at: datetime


class PartUnitEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_type: str
    quantity_delta: float
    from_stage_id: int | None
    to_stage_id: int | None
    area: str | None
    write_off_reason: str | None
    write_off_note: str | None
    user_id: int
    occurred_at: datetime
    note: str | None
