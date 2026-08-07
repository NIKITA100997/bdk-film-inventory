from datetime import datetime

from pydantic import BaseModel, Field


class PurchaseRequestCreate(BaseModel):
    material: str
    color: str
    thickness: float
    requested_area_m2: float = Field(gt=0)
    note: str | None = None


class PurchaseRequestOut(BaseModel):
    id: int
    material: str
    color: str
    thickness: float
    requested_area_m2: float
    current_stock_m2: float
    note: str | None
    status: str
    created_by: int
    created_at: datetime
    closed_at: datetime | None
