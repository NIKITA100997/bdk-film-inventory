from pydantic import BaseModel, ConfigDict, Field

from app.models.storage import RackType
from app.schemas.units import MaterialUnitOut


class WarehouseCreate(BaseModel):
    name: str
    address: str | None = None


class WarehouseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    address: str | None
    is_active: bool


class WarehouseUpdate(BaseModel):
    name: str | None = None
    address: str | None = None
    is_active: bool | None = None


class RackCreate(BaseModel):
    code: str
    type: RackType
    shelf_count: int = Field(gt=0)
    strip_capacity: int | None = Field(default=None, gt=0)
    warehouse_id: int


class RackOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    code: str
    type: RackType
    shelf_count: int
    strip_capacity: int | None
    warehouse_id: int
    is_active: bool


class RackUpdate(BaseModel):
    code: str | None = None
    type: RackType | None = None
    shelf_count: int | None = Field(default=None, gt=0)
    strip_capacity: int | None = Field(default=None, gt=0)
    warehouse_id: int | None = None
    is_active: bool | None = None


class MacroZoneRuleCreate(BaseModel):
    from_shelf: int = Field(gt=0)
    to_shelf: int = Field(gt=0)
    material: str | None = None
    color: str | None = None
    thickness: float | None = None
    manufacturer: str | None = None


class MacroZoneRuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    rack_id: int
    from_shelf: int
    to_shelf: int
    material_id: int | None
    color_id: int | None
    thickness_id: int | None
    manufacturer_id: int | None


class LocationSuggestion(BaseModel):
    location_code: str | None


class RackOccupancyCellOut(BaseModel):
    """Одна полка стеллажа (4.1 ТЗ) — рулонные и штрипсовые адресуются
    одинаково (полка целиком, без ячеек). `capacity` — сколько единиц
    может занимать этот адрес одновременно (1 для рулонных, где полка =
    один рулон; `Rack.strip_capacity` для штрипсовых). `units` — что
    сейчас физически на полке, пустой список = свободна."""

    shelf: int
    location_code: str
    units: list[MaterialUnitOut]
    capacity: int
