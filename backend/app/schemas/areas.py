from pydantic import BaseModel, ConfigDict


class AreaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    code: str
    name: str
    is_active: bool


class AreaCreate(BaseModel):
    name: str


class AreaUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None
