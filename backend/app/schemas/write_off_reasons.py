from typing import Literal

from pydantic import BaseModel, ConfigDict

ReasonCategory = Literal["warehouse", "production", "general"]


class WriteOffReasonOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    code: str
    name: str
    is_active: bool
    is_system: bool
    category: ReasonCategory


class WriteOffReasonCreate(BaseModel):
    name: str
    category: ReasonCategory = "general"


class WriteOffReasonUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None
    category: ReasonCategory | None = None
