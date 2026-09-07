from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.part_units import PartUnitStatus


class PartUnitCreate(BaseModel):
    """Регистрация партии начальником цеха (раздел про физический учёт
    деталей) — квант работы: один вызов = одна нарезанная партия. `issue`
    — сразу выдать участку (обычно уже известно, для чего нарезали),
    иначе партия остаётся "На_хранении" до отдельной выдачи. Раздел про
    связь этапов с участками — участок выдачи выводится из первого этапа
    детали, не выбирается вручную (см. PartStage.area)."""

    part_id: int
    quantity_pieces: float = Field(gt=0)
    production_task_line_id: int | None = None
    issue: bool = False
    note: str | None = None


class PartUnitPlace(BaseModel):
    location_code: str


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
    from_cell: str | None
    to_cell: str | None
    area: str | None
    write_off_reason: str | None
    write_off_note: str | None
    user_id: int
    occurred_at: datetime
    note: str | None
