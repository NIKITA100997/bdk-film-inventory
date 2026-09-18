from pydantic import BaseModel, ConfigDict


class PartFilmRestrictionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    code: str
    name: str
    is_active: bool


class PartFilmRestrictionCreate(BaseModel):
    name: str


class PartFilmRestrictionUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None
