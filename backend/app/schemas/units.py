from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, computed_field

from app.models.events import EventType
from app.models.units import UnitStatus
from app.schemas.dictionaries import MaterialSkuOut


class ReceiveRequest(BaseModel):
    upd_number: str
    pallet_number: str
    material: str
    color: str
    thickness: float
    manufacturer: str
    width_mm: float = Field(gt=0)
    length_m: float = Field(gt=0)
    quantity: int = Field(gt=0, le=200)
    location_code: str | None = None


class MaterialUnitOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    parent_id: int | None
    upd_number: str
    pallet_number: str
    material_sku: MaterialSkuOut
    width_mm: float
    length_m: float
    status: UnitStatus
    area: str | None
    location_code: str | None
    production_task_line_id: int | None
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def area_m2(self) -> float:
        return round(float(self.width_mm) * float(self.length_m) / 1000, 3)


class WriteOffRequest(BaseModel):
    """reason — code причины из write_off_reasons (раздел про
    администрирование причин). Системные причины (is_system=True,
    например "Отход при раскрое" — выставляется только автоматически
    при раскрое, split_unit) вручную через это тело недоступны, проверка
    в api/units.py::write_off (нужен доступ к БД, не делается на уровне
    схемы)."""

    reason: str
    note: str | None = None


class PlaceRequest(BaseModel):
    location_code: str


class ReassignSkuRequest(BaseModel):
    """Исправление ошибки ввода (раздел про карточку материала) — сменить
    номенклатуру уже существующей единицы, когда при вводе (например,
    начальных остатков) выбрали не тот материал/цвет/толщину/
    производителя. Единица физически никуда не переезжает, id и история
    движений сохраняются."""

    material: str
    color: str
    thickness: float
    manufacturer: str


class SplitRequest(BaseModel):
    separate_width_mm: float = Field(gt=0)
    new_unit_location: str | None = None


class SplitResponse(BaseModel):
    parent: MaterialUnitOut
    new_unit: MaterialUnitOut | None


class IssueRequest(BaseModel):
    material: str
    color: str
    thickness: float
    manufacturer: str
    width_mm: float = Field(gt=0)
    length_m: float = Field(gt=0)
    area: str
    production_task_line_id: int | None = None


class IssueDirectRequest(BaseModel):
    """Выдача конкретной единицы напрямую (3 раздел обратной связи) —
    оператор выбирает готовый рулон/штрипс из списка "в наличии" вместо
    поиска по атрибутам+ширине."""

    area: str
    production_task_line_id: int | None = None


class DonorSuggestion(BaseModel):
    """Рекомендация "донор-штрипс" (2.9 п.2 ТЗ) — не выполняется
    автоматически, только предлагается; оператор режет вручную через
    /units/{id}/split и подтверждает выдачу отдельным запросом."""

    unit_id: int
    width_mm: float
    length_m: float
    width_class: str
    recommended_cut_mm: float
    waste_mm: float
    days_in_storage: int = 0


class IssueResult(BaseModel):
    outcome: str  # "issued" | "donor_suggested" | "not_found"
    unit: MaterialUnitOut | None = None
    donor: DonorSuggestion | None = None


class AtomicDonorIssueRequest(BaseModel):
    donor_unit_id: int
    requested_width_mm: float = Field(gt=0)
    area: str
    production_task_line_id: int | None = None


class AtomicDonorIssueResponse(BaseModel):
    issued_unit: MaterialUnitOut
    remainder_unit: MaterialUnitOut | None = None


class CuttingPlanRequest(BaseModel):
    """Раздел про план резки на несколько разных штрипсов одной плёнки —
    needed_widths_mm обычно приходит из группы "одна плёнка на N заданий"
    на экране выдачи (каждая ширина — своя строка задания на сегодня)."""

    material: str
    color: str
    thickness: float
    manufacturer: str
    needed_widths_mm: list[float] = Field(min_length=1)


class CuttingPlanDonorOut(BaseModel):
    unit_id: int
    width_mm: float
    length_m: float
    days_in_storage: int


class CuttingPlanOut(BaseModel):
    donor: CuttingPlanDonorOut | None
    covered_widths_mm: list[float]
    uncovered_widths_mm: list[float]
    waste_mm: float
    # Индексы needed_widths_mm, которые донор покрывает (раздел про
    # исполнение плана) — при повторяющихся ширинах в запросе (два
    # задания просят одну и ту же ширину) значения covered_widths_mm
    # неоднозначны, индексы позволяют однозначно сопоставить обратно с
    # исходными строками задания на фронте.
    covered_indices: list[int]


class CuttingPlanCutSpec(BaseModel):
    """Один кусок из плана резки — на какую строку задания идёт, какой
    ширины, и контрольная (реально отмотанная станком) длина."""

    production_task_line_id: int
    width_mm: float = Field(gt=0)
    actual_length_m: float = Field(ge=0)


class CuttingPlanExecuteRequest(BaseModel):
    donor_unit_id: int
    cuts: list[CuttingPlanCutSpec] = Field(min_length=1)


class CuttingPlanExecuteResultCut(BaseModel):
    unit: MaterialUnitOut
    production_task_line_id: int
    expected_length_m: float
    actual_length_m: float
    discrepancy_flagged: bool


class CuttingPlanExecuteResponse(BaseModel):
    donor_remainder: MaterialUnitOut | None
    cuts: list[CuttingPlanExecuteResultCut]


class CutRequest(BaseModel):
    cut_length_m: float = Field(gt=0)
    remainder_location: str | None = None


class ReturnRequest(BaseModel):
    actual_length_m: float = Field(ge=0)


class ReturnPreviewOut(BaseModel):
    """Подсказка перед возвратом (раздел про возврат остатка) — сколько
    плёнки должно остаться по расчёту (выдано минус хорошие и брак),
    прежде чем оператор физически обмерит и введёт фактическую длину.
    expected_return_length_m=None, если единица не привязана к строке
    задания — считать не из чего."""

    expected_return_length_m: float | None
    good_pieces: float
    defect_pieces: float


class UnitEventOut(BaseModel):
    """История единицы для карточки единицы (2.1 раздел бэклога доработок)
    — "кто и когда с ней что делал"."""

    model_config = ConfigDict(from_attributes=True)
    event_id: int
    event_type: EventType
    timestamp: datetime
    user_id: int
    from_length: float | None
    to_length: float | None
    from_cell: str | None
    to_cell: str | None
    quantity_delta_m: float
    write_off_reason: str | None
    write_off_note: str | None
    expected_length_m: float | None
