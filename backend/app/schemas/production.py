from datetime import date, datetime

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
    area: Area
    qty_per_unit: float = Field(gt=0)
    width_mm: float = Field(gt=0)
    length_m: float = Field(gt=0)
    strip_width_mm: float | None = None
    part_name: str | None = None


class ProductModelPartOut(BaseModel):
    id: int
    area: Area
    qty_per_unit: float
    width_mm: float
    length_m: float
    strip_width_mm: float | None = None
    part_name: str | None


class ProductModelOut(BaseModel):
    id: int
    name: str
    area: Area
    is_active: bool
    parts: list[ProductModelPartOut] = []


class ProductionTaskLineManualCreate(BaseModel):
    line_id: int | None = None
    material: str
    color: str
    thickness: float
    quantity_pieces: float = Field(gt=0)
    width_mm: float = Field(gt=0)
    length_m: float = Field(gt=0)
    strip_width_mm: float | None = None
    part_name: str | None = None


class ProductionTaskManualCreate(BaseModel):
    name: str
    area: Area
    product_model_id: int | None = None
    quantity: int | None = None
    # Заказ, для которого создано задание (раздел про потребности по всему
    # заказу) — необязательно, как product_model_id/quantity.
    order_id: int | None = None
    lines: list[ProductionTaskLineManualCreate] = Field(min_length=1)


class ProductionTaskLineReportCreate(BaseModel):
    # Раздел про брак по дням — отчёт всегда за конкретную запись
    # распределения (день/линия/сотрудники), не за строку задания целиком.
    assignment_id: int
    good_pieces: float = Field(ge=0)
    defect_pieces: float = Field(ge=0)
    defect_reason: WriteOffReason | None = None
    note: str | None = None


class ProductionTaskLineReportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    assignment_id: int | None
    good_pieces: float
    defect_pieces: float
    defect_reason: WriteOffReason | None
    note: str | None
    reported_by: int
    reported_at: datetime


class ProductionTaskLineAssignmentCreate(BaseModel):
    line_id: int
    date: date
    employee_names: str = Field(min_length=1)
    quantity_pieces: float = Field(gt=0)


class ProductionTaskLineAssignmentOut(BaseModel):
    id: int
    line_id: int
    line_name: str
    date: date
    employee_names: str
    quantity_pieces: float
    created_by: int
    created_at: datetime
    # Агрегаты по ProductionTaskLineReport, отфильтрованным по этой
    # конкретной записи распределения (раздел про брак по дням) — именно
    # это позволяет видеть факт/брак за конкретный день, а не за всю
    # строку задания.
    produced_good_pieces: float = 0.0
    defect_pieces: float = 0.0


class ProductionTaskLineOut(BaseModel):
    id: int
    line_id: int | None
    line_name: str
    material: str
    color: str
    thickness: float
    quantity_pieces: float
    width_mm: float
    length_m: float
    strip_width_mm: float | None = None
    part_name: str | None
    # Агрегаты по ProductionTaskLineReport (раздел про брак в
    # производстве) — quantity_pieces сама не мутируется, остаток считается
    # на лету из накопительного журнала отчётов.
    produced_good_pieces: float
    defect_pieces: float
    remaining_pieces: float
    remaining_length_m: float
    # Агрегаты по ProductionTaskLineAssignment (раздел про распределение по
    # линиям) — сколько из quantity_pieces уже расписано по линиям/дням.
    assigned_pieces: float
    unassigned_pieces: float
    assignments: list[ProductionTaskLineAssignmentOut] = []


class ProductionTaskOut(BaseModel):
    id: int
    product_model_id: int | None
    product_model_name: str | None
    name: str | None
    area: Area
    quantity: int | None
    order_id: int | None
    created_by: int
    created_at: datetime
    lines: list[ProductionTaskLineOut]
