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
    width_mm: float = Field(gt=0)
    length_m: float = Field(gt=0)
    part_name: str | None = None


class ProductModelPartOut(BaseModel):
    id: int
    line_id: int
    line_name: str
    material: str
    color: str
    thickness: float
    qty_per_unit: float
    width_mm: float
    length_m: float
    part_name: str | None


class ProductModelOut(BaseModel):
    id: int
    name: str
    area: Area
    is_active: bool
    parts: list[ProductModelPartOut] = []


class ProductionTaskLineManualCreate(BaseModel):
    line_id: int
    material: str
    color: str
    thickness: float
    quantity_pieces: float = Field(gt=0)
    width_mm: float = Field(gt=0)
    length_m: float = Field(gt=0)
    part_name: str | None = None


class ProductionTaskManualCreate(BaseModel):
    """Раздел про распределение по линиям — единый способ создания задания:
    строки задаются напрямую (либо вручную с нуля, либо предложены из BOM
    модели и затем отредактированы/раздроблены по линиям на фронтенде —
    сервер не различает эти два случая, ему приходит уже готовый список
    строк). product_model_id/quantity — необязательны, только для
    отображения "из какой модели и на какое количество" в списке заданий."""

    name: str
    area: Area
    product_model_id: int | None = None
    quantity: int | None = None
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
    # Раздел про размер детали — размер куска плёнки на одну деталь; склад
    # видит их на "Выдаче участку", чтобы знать, что резать/выдавать.
    width_mm: float
    length_m: float
    # Раздел про распределение по линиям — название детали ("Стоевая" и
    # т.п.), чтобы строки различались не только цифрами размера.
    part_name: str | None
    # Агрегаты по ProductionTaskLineReport (раздел про брак в
    # производстве) — quantity_pieces сама не мутируется, остаток считается
    # на лету из накопительного журнала отчётов.
    produced_good_pieces: float
    defect_pieces: float
    remaining_pieces: float
    remaining_length_m: float


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
