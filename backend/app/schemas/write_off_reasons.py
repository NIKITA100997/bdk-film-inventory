from pydantic import BaseModel, ConfigDict


class WriteOffReasonOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    code: str
    name: str
    is_active: bool
    is_system: bool


class WriteOffReasonCreate(BaseModel):
    name: str


class WriteOffReasonUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None
