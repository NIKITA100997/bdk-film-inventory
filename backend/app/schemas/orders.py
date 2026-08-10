from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class OrderCreate(BaseModel):
    number: str


class OrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    number: str
    status: str
    created_at: datetime
    closed_at: datetime | None


class OrderLineCreate(BaseModel):
    material: str
    color: str
    thickness: float
    planned_area_m2: float = Field(gt=0)


class OrderLineOut(BaseModel):
    """Строка потребности с план/фактом сразу — план/факт заказа больше не
    отдельный экран (4 раздел обратной связи, было /plan-fact по неделе)."""

    id: int
    material: str
    color: str
    thickness: float
    planned_area_m2: float
    current_stock_m2: float
    shortage: bool
    actual_area_m2: float
    percent_complete: float
    by_width: dict[float, float]


class OrderDetailOut(OrderOut):
    lines: list[OrderLineOut]


class OrderShortageLine(BaseModel):
    """Сигнал нехватки (2.7/6.1 ТЗ) — строка потребности открытого заказа,
    где остаток на складе меньше плановой потребности. Раньше источником
    был "последний недельный план", теперь — все открытые заказы сразу."""

    order_id: int
    order_number: str
    line_id: int
    material: str
    color: str
    thickness: float
    planned_area_m2: float
    current_stock_m2: float


class OrderReportLine(BaseModel):
    """Сводный отчёт по всем заказам (4 раздел обратной связи) — отдельно
    от карточки конкретного заказа."""

    id: int
    number: str
    status: str
    created_at: datetime
    closed_at: datetime | None
    planned_area_m2: float
    actual_area_m2: float
    percent_complete: float
    shortage_line_count: int
