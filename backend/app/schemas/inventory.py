from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.inventory import InventoryScopeType, InventoryStatus
from app.schemas.units import MaterialUnitOut


class InventorySessionCreate(BaseModel):
    scope_type: InventoryScopeType
    scope_ref_id: int | None = None

    @model_validator(mode="after")
    def _scope_ref_required_unless_warehouse(self):
        if self.scope_type != InventoryScopeType.WAREHOUSE and self.scope_ref_id is None:
            raise ValueError("scope_ref_id обязателен для scope_type != warehouse")
        return self


class InventorySessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    scope_type: InventoryScopeType
    scope_ref_id: int | None
    status: InventoryStatus
    started_by: int
    closed_by: int | None
    started_at: datetime
    closed_at: datetime | None
    expected_count: int
    scanned_count: int


class ScanRequest(BaseModel):
    location_code: str
    unit_id: int | None = None
    # Обязательны, только если unit_id не задан (единица не найдена — создание, как на приёмке).
    material: str | None = None
    color: str | None = None
    thickness: float | None = None
    manufacturer: str | None = None
    width_mm: float | None = Field(default=None, gt=0)
    length_m: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _creation_fields_required_when_no_unit_id(self):
        if self.unit_id is None:
            missing = [
                name
                for name, value in (
                    ("material", self.material),
                    ("color", self.color),
                    ("thickness", self.thickness),
                    ("manufacturer", self.manufacturer),
                    ("width_mm", self.width_mm),
                    ("length_m", self.length_m),
                )
                if value is None
            ]
            if missing:
                raise ValueError(f"Единица не найдена — заполните для создания: {', '.join(missing)}")
        return self


class ScanResult(BaseModel):
    outcome: str  # confirmed / moved / surplus
    unit: MaterialUnitOut


class ShortageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    material_sku_id: int
    width_mm: float
    length_m: float
    location_code: str | None


class CloseSessionResult(BaseModel):
    session: InventorySessionOut
    confirmed_count: int
    moved_count: int
    surplus_count: int
    shortages: list[ShortageOut]


class ResolveShortageRequest(BaseModel):
    action: str  # "spisat" | "vernut_v_poisk"
