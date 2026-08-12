from datetime import datetime

from pydantic import BaseModel, ConfigDict


class SupplierOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    contact: str | None
    is_active: bool


class SupplierCreate(BaseModel):
    name: str
    contact: str | None = None


class SupplierUpdate(BaseModel):
    name: str | None = None
    contact: str | None = None
    is_active: bool | None = None


class SupplierStatsOut(BaseModel):
    """История цен и сроков поставщика — агрегат по закрытым заявкам с
    проставленным поставщиком. Срок поставки не хранится отдельным полем —
    считается как closed_at - created_at у самих заявок."""

    supplier_id: int
    supplier_name: str
    closed_requests: int
    avg_price_per_m2: float | None
    avg_lead_time_days: float | None
    last_request_at: datetime
