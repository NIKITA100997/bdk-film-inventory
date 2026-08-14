from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator

from app.models.events import EventType, WriteOffReason
from app.models.units import UnitStatus
from app.models.users import Area
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
    area: Area | None
    location_code: str | None
    production_task_line_id: int | None
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def area_m2(self) -> float:
        return round(float(self.width_mm) * float(self.length_m) / 1000, 3)


class WriteOffRequest(BaseModel):
    """CUTTING_WASTE зарезервирована для автоматического списания отхода при
    раскрое (split_unit) — вручную через это тело её выбрать нельзя."""

    reason: WriteOffReason
    note: str | None = None

    @field_validator("reason")
    @classmethod
    def _no_cutting_waste(cls, v: WriteOffReason) -> WriteOffReason:
        if v == WriteOffReason.CUTTING_WASTE:
            raise ValueError("Причина 'Отход при раскрое' выставляется автоматически, не вручную")
        return v


class PlaceRequest(BaseModel):
    location_code: str


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
    area: Area
    production_task_line_id: int | None = None


class IssueDirectRequest(BaseModel):
    """Выдача конкретной единицы напрямую (3 раздел обратной связи) —
    оператор выбирает готовый рулон/штрипс из списка "в наличии" вместо
    поиска по атрибутам+ширине."""

    area: Area
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
    area: Area
    production_task_line_id: int | None = None


class AtomicDonorIssueResponse(BaseModel):
    issued_unit: MaterialUnitOut
    remainder_unit: MaterialUnitOut | None = None


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
    write_off_reason: WriteOffReason | None
    write_off_note: str | None
