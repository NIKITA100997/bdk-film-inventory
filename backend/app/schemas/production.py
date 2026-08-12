from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.events import WriteOffReason
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


class ProductionTaskLineManualCreate(BaseModel):
    line_id: int
    material: str
    color: str
    thickness: float
    quantity_pieces: float = Field(gt=0)


class ProductionTaskManualCreate(BaseModel):
    """Ручное создание задания (раздел про ручной режим) — пока не все
    модели продукции описаны в BOM: строки задаются напрямую, без модели."""

    name: str
    area: Area
    lines: list[ProductionTaskLineManualCreate] = Field(min_length=1)


class ProductionTaskLineReportCreate(BaseModel):
    """Отчёт о факте производства по строке задания (раздел про брак в
    производстве) — брак обнаруживается в процессе окутки, на уровне
    готовых деталей, не привязан к конкретному рулону."""

    good_pieces: float = Field(ge=0)
    defect_pieces: float = Field(ge=0)
    defect_reason: WriteOffReason | None = None
    note: str | None = None


class ProductionTaskLineReportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    good_pieces: float
    defect_pieces: float
    defect_reason: WriteOffReason | None
    note: str | None
    reported_by: int
    reported_at: datetime


class ProductionTaskLineOut(BaseModel):
    id: int
    line_id: int
    line_name: str
    material: str
    color: str
    thickness: float
    quantity_pieces: float
    # Агрегаты по ProductionTaskLineReport (раздел про брак в
    # производстве) — quantity_pieces сама не мутируется, остаток считается
    # на лету из накопительного журнала отчётов.
    produced_good_pieces: float
    defect_pieces: float
    remaining_pieces: float


class ProductionTaskOut(BaseModel):
    id: int
    product_model_id: int | None
    product_model_name: str | None
    name: str | None
    area: Area
    quantity: int | None
    created_by: int
    created_at: datetime
    lines: list[ProductionTaskLineOut]
