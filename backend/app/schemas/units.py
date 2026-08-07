from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, computed_field

from app.models.units import UnitStatus
from app.models.users import Area


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
    material: str
    color: str
    thickness: float
    manufacturer: str
    width_mm: float
    length_m: float
    status: UnitStatus
    area: Area | None
    location_code: str | None
    order_id: int | None
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def area_m2(self) -> float:
        return round(float(self.width_mm) * float(self.length_m) / 1000, 3)
