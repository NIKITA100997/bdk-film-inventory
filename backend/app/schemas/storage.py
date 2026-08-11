from pydantic import BaseModel, ConfigDict, Field

from app.models.storage import RackType
from app.schemas.units import MaterialUnitOut


class RackCreate(BaseModel):
    code: str
    type: RackType
    shelf_count: int = Field(gt=0)


class RackOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    code: str
    type: RackType
    shelf_count: int
    is_active: bool


class RackUpdate(BaseModel):
    code: str | None = None
    type: RackType | None = None
    shelf_count: int | None = Field(default=None, gt=0)
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
    """Одна физическая ячейка адресации (4.1 ТЗ) для схемы стеллажа —
    полка целиком для рулонного стеллажа (`cell=None`), полка+ячейка для
    штрипсового. `unit=None` — ячейка свободна."""

    shelf: int
    cell: int | None
    location_code: str
    unit: MaterialUnitOut | None
