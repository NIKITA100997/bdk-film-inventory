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
    width_mm: float
    total_length_m: float
    unit_count: int


class RollsVsStripsLine(BaseModel):
    material: str
    color: str
    thickness: float
    roll_count: int
    roll_length_m: float
    strip_count: int
    strip_length_m: float


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


class PlanFactTaskLineOut(BaseModel):
    """План/факт по расходу плёнки на строку задания (раздел про выдачу
    мимо хаба) — план не мутируется (quantity_pieces × length_m на
    строке), факт — уже выданный/отрезанный складом метраж
    (fetch_issued_length_by_task_line, warehouse-driven, не зависит от
    бумажной самоотчётности цеха о производстве)."""

    task_id: int
    task_name: str | None
    area: str
    line_id: int
    part_name: str | None
    material: str
    color: str
    thickness: float
    planned_length_m: float
    actual_length_m: float
    remaining_length_m: float
    completion_percent: float
    created_at: datetime


# ---------- Раздел про модуль "Брак и списания" ----------


class ActionLogMaterialLine(BaseModel):
    """Раздел про журнал действий — расширенная версия MovementEntry:
    полные поля события плюс пользователь по имени и деталь/задание
    (как в cutting_discrepancies), для плоской хронологии по всем
    рулонам/штрипсам сразу — не заменяет специализированные экраны
    (история резок с «Отменить», «Перемещения между складами»,
    «Инвентаризация»), дополняет их."""

    event_id: int
    unit_id: int
    timestamp: datetime
    user_id: int
    user_name: str
    event_type: str
    area: str | None
    material: str
    color: str
    thickness: float
    width_mm: float
    quantity_delta_m: float
    from_length: float | None
    to_length: float | None
    from_cell: str | None
    to_cell: str | None
    write_off_reason: str | None
    write_off_reason_name: str | None
    write_off_note: str | None
    expected_length_m: float | None
    cutting_operation_id: int | None
    inventory_session_id: int | None
    production_task_line_id: int | None
    part_name: str | None
    task_name: str | None


class ActionLogPartUnitLine(BaseModel):
    """Раздел про журнал действий — зеркало ActionLogMaterialLine для
    партий п/ф (PartUnitEvent)."""

    id: int
    part_unit_id: int
    occurred_at: datetime
    user_id: int
    user_name: str
    event_type: str
    area: str | None
    part_name: str
    stage_name: str | None
    quantity_delta: float
    from_stage_id: int | None
    to_stage_id: int | None
    from_cell: str | None
    to_cell: str | None
    write_off_reason: str | None
    write_off_reason_name: str | None
    write_off_note: str | None
    production_task_line_id: int | None
    task_name: str | None
    note: str | None


class UnitReconciliationLine(BaseModel):
    """Раздел про ревизию путей плёнки — рулон/штрипс, у которого
    выданное не сходится с (расход по отчётам + списано + осталось).
    Тот самый класс расхождений, из-за которых в этой сессии чинили
    штрипсы №2115/№2324/партии строки «Багет Б-2/М» — только теперь
    находится сам, не по жалобе оператора."""

    unit_id: int
    material: str
    color: str
    thickness: float
    width_mm: float
    status: str
    area: str | None
    part_name: str | None
    task_name: str | None
    issued_total_m: float
    consumed_calc_m: float
    written_off_m: float
    current_length_m: float | None
    # None — рулон ещё выдан участку, физического "было измерено"
    # факта пока нет, сравниваем только "не превысил ли расход
    # выданное" (over_consumed_m); иначе — полный баланс.
    variance_m: float | None
    over_consumed_m: float
    updated_at: datetime


class PartUnitReconciliationLine(BaseModel):
    """Раздел про ревизию путей п/ф — партия, у которой сумма good_pieces
    уже отчитанных по ней (reported_good_pieces_by_unit) превышает её
    же quantity_pieces. Расход по отчётам не может физически превышать
    то, что когда-либо было в партии — если превышает, где-то задвоение
    (тот же класс проблемы, что бага "доп. рулон второй раз списывал
    партию п/ф", найденного и исправленного при этой же ревизии)."""

    unit_id: int
    part_name: str
    stage_name: str
    status: str
    area: str | None
    quantity_pieces: float
    reported_good_pieces: float
    over_reported: float
    updated_at: datetime


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
