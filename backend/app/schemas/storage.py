from pydantic import BaseModel, ConfigDict, Field

from app.models.storage import RackType


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
