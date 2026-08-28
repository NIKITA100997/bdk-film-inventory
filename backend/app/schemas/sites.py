from pydantic import BaseModel, ConfigDict


class SiteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    warehouse_id: int
    is_active: bool


class SiteCreate(BaseModel):
    name: str
    warehouse_id: int


class SiteUpdate(BaseModel):
    name: str | None = None
    warehouse_id: int | None = None
    is_active: bool | None = None
