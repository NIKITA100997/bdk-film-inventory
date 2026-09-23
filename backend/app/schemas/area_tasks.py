from datetime import date, datetime

from pydantic import BaseModel, Field


class AreaTaskLineCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    quantity_pieces: float = Field(gt=0)
    part_stage_id: int | None = None
    note: str | None = None


class AreaTaskCreate(BaseModel):
    area: str
    name: str = Field(min_length=1, max_length=255)
    ship_date: date | None = None
    note: str | None = None
    lines: list[AreaTaskLineCreate] = Field(min_length=1)


class AreaTaskUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    ship_date: date | None = None
    note: str | None = None
    is_active: bool | None = None


class AreaTaskReportCreate(BaseModel):
    good_pieces: float = Field(default=0, ge=0)
    defect_pieces: float = Field(default=0, ge=0)
    defect_reason: str | None = None
    note: str | None = None
    occurred_at: datetime | None = None


class AreaTaskReportOut(BaseModel):
    id: int
    good_pieces: float
    defect_pieces: float
    defect_reason: str | None
    note: str | None
    reported_by: int
    reported_by_name: str
    occurred_at: datetime


class AreaTaskLineOut(BaseModel):
    id: int
    sort_order: int
    name: str
    quantity_pieces: float
    part_stage_id: int | None
    part_id: int | None
    part_name: str | None
    stage_name: str | None
    note: str | None
    good_pieces: float
    defect_pieces: float
    remaining_pieces: float


class AreaTaskOut(BaseModel):
    id: int
    area: str
    name: str
    source: str
    ship_date: date | None
    note: str | None
    is_active: bool
    created_by: int
    created_at: datetime
    lines: list[AreaTaskLineOut]


class AreaPartStageOut(BaseModel):
    """Этап детали п/ф, выполняемый на участке — вариант для привязки строки."""

    part_stage_id: int
    part_id: int
    part_name: str
    stage_name: str
    is_first: bool
