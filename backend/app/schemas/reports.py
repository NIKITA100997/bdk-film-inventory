from datetime import date, datetime
from typing import Literal

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


# ---------- Раздел про модуль "Брак и списания" ----------


class WriteOffLine(BaseModel):
    event_id: int
    unit_id: int
    timestamp: datetime
    material: str
    color: str
    thickness: float
    width_mm: float
    quantity_m: float
    reason_code: str | None
    reason_name: str | None
    note: str | None
    user_name: str
    is_cutting_waste: bool


class ProductionDefectLine(BaseModel):
    report_id: int
    reported_at: datetime
    task_id: int
    task_name: str | None
    part_name: str | None
    area: str
    area_name: str
    line_id: int | None
    line_name: str | None
    defect_pieces: float
    good_pieces: float
    reason_code: str | None
    reason_name: str | None
    note: str | None
    reported_by_name: str


class ReasonShareLine(BaseModel):
    reason_name: str
    amount: float
    share_percent: float


class TopWriteOffMaterialLine(BaseModel):
    material: str
    color: str
    thickness: float
    amount_m: float
    events: int


class TopDefectGroupLine(BaseModel):
    level: Literal["area", "line"]
    label: str
    parent_label: str | None
    defect_pieces: float
    good_pieces: float
    defect_rate_percent: float


class DefectsOverviewOut(BaseModel):
    period_from: date
    period_to: date
    warehouse_total_m: float
    warehouse_total_m_delta_percent: float | None
    warehouse_cutting_waste_m: float
    warehouse_real_defect_m: float
    warehouse_real_defect_m_delta_percent: float | None
    warehouse_events_count: int
    production_defect_pieces: float
    production_defect_pieces_delta_percent: float | None
    production_good_pieces: float
    production_defect_rate_percent: float
    warehouse_reasons: list[ReasonShareLine]
    production_reasons: list[ReasonShareLine]
    top_materials: list[TopWriteOffMaterialLine]
    top_defect_groups: list[TopDefectGroupLine]


class TrendPoint(BaseModel):
    period_from: date
    period_to: date
    label: str
    warehouse_m: float
    production_defect_pieces: float


class DefectPivotRowOut(BaseModel):
    group_label: str
    parent_label: str | None
    by_reason: dict[str, float]
    defect_pieces: float
    good_pieces: float
    defect_rate_percent: float


class DefectPivotOut(BaseModel):
    group_by: Literal["detail", "area", "line"]
    reasons: list[str]
    rows: list[DefectPivotRowOut]
    total: DefectPivotRowOut
