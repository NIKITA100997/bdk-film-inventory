from datetime import date

from pydantic import BaseModel, ConfigDict, Field


class FilmRequestLineCreate(BaseModel):
    material: str
    color: str
    thickness: float
    planned_area_m2: float = Field(gt=0)


class FilmRequestLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    material: str
    color: str
    thickness: float
    planned_area_m2: float
    current_stock_m2: float
    shortage: bool


class WeeklyPlanCreate(BaseModel):
    week_start: date
    week_end: date


class WeeklyPlanOut(BaseModel):
    id: int
    week_start: date
    week_end: date
    created_by: int
    status: str
    lines: list[FilmRequestLineOut]


class PlanFactLine(BaseModel):
    line_id: int
    material: str
    color: str
    thickness: float
    planned_area_m2: float
    actual_area_m2: float
    percent_complete: float
    by_width: dict[float, float]


class PlanFactOut(BaseModel):
    week_id: int
    week_start: date
    week_end: date
    lines: list[PlanFactLine]
