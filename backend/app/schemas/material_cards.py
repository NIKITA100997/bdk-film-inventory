from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.events import EventType
from app.models.users import Area
from app.schemas.dictionaries import MaterialSkuOut
from app.schemas.units import MaterialUnitOut


class MaterialEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    event_id: int
    unit_id: int
    event_type: EventType
    area: Area | None
    timestamp: datetime
    user_id: int
    width_mm: float
    from_length: float | None
    to_length: float | None
    from_cell: str | None
    to_cell: str | None
    quantity_delta_m: float


class MaterialCardPlanFact(BaseModel):
    """Агрегат план/факта по всем открытым заказам с этим материалом (4
    раздел обратной связи — раньше был один недельный план, теперь заказов
    может быть несколько сразу)."""

    order_count: int
    planned_area_m2: float
    actual_area_m2: float
    percent_complete: float
    by_width: dict[float, float]


class MaterialCardOut(BaseModel):
    sku: MaterialSkuOut
    total_area_m2: float
    units: list[MaterialUnitOut]
    plan_fact: MaterialCardPlanFact | None
    events: list[MaterialEventOut]
