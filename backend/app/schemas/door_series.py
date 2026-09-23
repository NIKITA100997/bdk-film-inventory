from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

EdgeType = Literal["abs", "aluminum"]


class DoorSeriesCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    frame_thickness_mm: float = Field(gt=0)
    panel_mdf_thickness_mm: float = Field(gt=0)
    edge_type: EdgeType


class DoorSeriesUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    frame_thickness_mm: float | None = Field(default=None, gt=0)
    panel_mdf_thickness_mm: float | None = Field(default=None, gt=0)
    edge_type: EdgeType | None = None
    is_active: bool | None = None


class DoorSeriesOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    frame_thickness_mm: float
    panel_mdf_thickness_mm: float
    edge_type: EdgeType
    is_active: bool
