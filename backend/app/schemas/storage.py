from pydantic import BaseModel, ConfigDict

from app.models.storage import RackType


class RackCreate(BaseModel):
    code: str
    type: RackType


class RackOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    code: str
    type: RackType


class ShelfCreate(BaseModel):
    number: int
    macro_zone: str | None = None


class ShelfOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    rack_id: int
    number: int
    macro_zone: str | None


class CellCreate(BaseModel):
    number: int


class CellOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    shelf_id: int
    number: int
