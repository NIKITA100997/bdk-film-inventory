from pydantic import BaseModel, ConfigDict, Field


class WidthAnalogGroupCreate(BaseModel):
    """Создать группу сразу со всеми её ширинами (раздел про аналоги
    ширин при выдаче) — не пошагово по одной, группа осмысленна только
    когда в ней хотя бы 2 ширины."""

    widths: list[float] = Field(min_length=2)
    note: str | None = None


class WidthAnalogGroupUpdate(BaseModel):
    """Полная замена состава группы (проще точечного add/remove одной
    ширины — тот же приём, что PUT /parts/{id}/stages для этапов детали)."""

    widths: list[float] = Field(min_length=2)
    note: str | None = None


class WidthAnalogMemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    width_mm: float


class WidthAnalogGroupOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    note: str | None
    members: list[WidthAnalogMemberOut]
