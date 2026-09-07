from pydantic import BaseModel, ConfigDict, Field

from app.schemas.part_units import PartUnitOut


class PartRackCreate(BaseModel):
    code: str
    shelf_count: int = Field(gt=0)


class PartRackOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    code: str
    shelf_count: int
    is_active: bool


class PartRackOccupancyCellOut(BaseModel):
    """Одна полка стеллажа п/ф — без лимита занятости (полка просто адрес,
    не ограничитель, см. открытые вопросы в BDK_Учет_ПФ_план.md), поэтому,
    в отличие от RackOccupancyCellOut у плёнки, нет поля `capacity`."""

    shelf: int
    location_code: str
    units: list[PartUnitOut]
