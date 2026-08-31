from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.schemas.common import OccurredAt
from app.schemas.units import MaterialUnitOut


class WarehouseTransferLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    unit: MaterialUnitOut
    added_at: datetime
    received_at: datetime | None


class WarehouseTransferOut(BaseModel):
    id: int
    from_warehouse_id: int
    from_warehouse_name: str
    to_warehouse_id: int
    to_warehouse_name: str
    status: str
    note: str | None
    created_at: datetime
    shipped_at: datetime | None
    received_at: datetime | None
    lines: list[WarehouseTransferLineOut]


class AddUnitToTransferRequest(BaseModel):
    unit_id: int
    to_warehouse_id: int
    note: str | None = None
    occurred_at: OccurredAt = None


class ReceiveTransferLineRequest(BaseModel):
    occurred_at: OccurredAt = None
