from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.users import Area


class ProductionLineCreate(BaseModel):
    name: str
    area: Area


class ProductionLineUpdate(BaseModel):
    name: str | None = None
    area: Area | None = None
    is_active: bool | None = None


class ProductionLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    area: Area
    is_active: bool


class ProductModelCreate(BaseModel):
    name: str
    area: Area


class ProductModelUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None


class ProductModelPartCreate(BaseModel):
    line_id: int
    material: str
    color: str
    thickness: float
    qty_per_unit: float = Field(gt=0)
    part_name: str | None = None


class ProductModelPartOut(BaseModel):
    id: int
    line_id: int
    line_name: str
    material: str
    color: str
    thickness: float
    qty_per_unit: float
    part_name: str | None


class ProductModelOut(BaseModel):
    id: int
    name: str
    area: Area
    is_active: bool
    parts: list[ProductModelPartOut] = []


class ProductionTaskCreate(BaseModel):
    product_model_id: int
    quantity: int = Field(gt=0)


class ProductionTaskLineOut(BaseModel):
    id: int
    line_id: int
    line_name: str
    material: str
    color: str
    thickness: float
    quantity_pieces: float


class ProductionTaskOut(BaseModel):
    id: int
    product_model_id: int
    product_model_name: str
    product_model_area: Area
    quantity: int
    created_by: int
    created_at: datetime
    lines: list[ProductionTaskLineOut]
