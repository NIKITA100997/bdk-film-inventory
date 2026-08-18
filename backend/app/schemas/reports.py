from datetime import date, datetime

from pydantic import BaseModel, ConfigDict


class StockSummaryLine(BaseModel):
    material: str
    color: str
    thickness: float
    total_area_m2: float
    unit_count: int


class StockByWidthLine(BaseModel):
    material: str
    color: str
    thickness: float
    manufacturer: str
    width_mm: float
    total_length_m: float
    unit_count: int


class MovementEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    event_id: int
    unit_id: int
    material: str
    color: str
    thickness: float
    manufacturer: str
    event_type: str
    area: str | None
    timestamp: datetime
    width_mm: float
    quantity_delta_m: float


class DonorAccuracyOut(BaseModel):
    period_from: date
    period_to: date
    suggested: int
    accepted: int
    accuracy_percent: float


class StaleUnitLine(BaseModel):
    unit_id: int
    material: str
    color: str
    thickness: float
    manufacturer: str
    width_mm: float
    length_m: float
    location_code: str | None
    last_moved_at: datetime
    days_idle: int


class CuttingDiscrepancyLine(BaseModel):
    """Раздел про план резки на несколько ширин за проход — строки, где
    контрольная (реально введённая) длина после резки заметно отличается
    от теоретической (см. /units/cutting-plan/execute)."""

    event_id: int
    unit_id: int
    area: str | None
    task_name: str | None
    part_name: str | None
    material: str
    color: str
    thickness: float
    expected_length_m: float
    actual_length_m: float
    discrepancy_m: float
    discrepancy_percent: float
    timestamp: datetime
    user_id: int
