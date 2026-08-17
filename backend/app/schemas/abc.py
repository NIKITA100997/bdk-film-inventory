from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.abc import WidthClass


class WidthAbcClassOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    material: str
    color: str
    thickness: float
    width_mm: float
    width_class: WidthClass
    total_length_m: float
    computed_at: datetime


class RecomputeResult(BaseModel):
    updated: int
    period_days: int


class CalcSettingsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    min_useful_width_mm: float
    abc_recalc_period_days: int
    stale_threshold_days: int
    shortage_note_template: str
    updated_at: datetime


class CalcSettingsUpdate(BaseModel):
    min_useful_width_mm: float = Field(gt=0)
    abc_recalc_period_days: int = Field(gt=0)
    stale_threshold_days: int = Field(gt=0)
    shortage_note_template: str = Field(min_length=1, max_length=255)
