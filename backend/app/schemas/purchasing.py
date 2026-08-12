from datetime import datetime

from pydantic import BaseModel, Field


class PurchaseRequestCreate(BaseModel):
    material: str
    color: str
    thickness: float
    requested_area_m2: float = Field(gt=0)
    note: str | None = None
    # История цен и сроков поставщика — оба необязательны, могут быть
    # согласованы позже создания заявки (см. PurchaseRequestUpdate).
    supplier: str | None = None
    price_per_m2: float | None = Field(default=None, gt=0)


class PurchaseRequestUpdate(BaseModel):
    """Заявка уже создана, но цена/поставщик согласованы позже — например,
    после переговоров. Материал/цвет/толщина/объём неизменны."""

    supplier: str | None = None
    price_per_m2: float | None = Field(default=None, gt=0)


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
    supplier: str | None
    price_per_m2: float | None
