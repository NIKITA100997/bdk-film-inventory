from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

EdgeType = Literal["abs", "aluminum"]


class DoorSeriesCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    frame_thickness_mm: float = Field(gt=0)
    panel_mdf_thickness_mm: float = Field(gt=0)
    edge_type: EdgeType
    has_glass: bool = False
    has_moulding: bool = False
    needs_lock_milling: bool = False
    milling_program: str | None = None


class DoorSeriesUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    frame_thickness_mm: float | None = Field(default=None, gt=0)
    panel_mdf_thickness_mm: float | None = Field(default=None, gt=0)
    edge_type: EdgeType | None = None
    has_glass: bool | None = None
    has_moulding: bool | None = None
    needs_lock_milling: bool | None = None
    milling_program: str | None = None
    is_active: bool | None = None


class DoorSeriesOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    frame_thickness_mm: float
    panel_mdf_thickness_mm: float
    edge_type: EdgeType
    has_glass: bool
    has_moulding: bool
    needs_lock_milling: bool
    milling_program: str | None
    is_active: bool
