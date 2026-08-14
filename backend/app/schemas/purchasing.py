from datetime import datetime

from pydantic import BaseModel, Field


class PurchaseRequestCreate(BaseModel):
    material: str
    color: str
    thickness: float
    requested_area_m2: float = Field(gt=0)
    note: str | None = None
    # История цен и сроков поставщика — оба необязательны, могут быть
    # согласованы позже создания заявки (см. PurchaseRequestUpdate).
    supplier: str | None = None
    price_per_m2: float | None = Field(default=None, gt=0)


class PurchaseRequestUpdate(BaseModel):
    """Заявка уже создана, но цена/поставщик согласованы позже — например,
    после переговоров. Материал/цвет/толщина/объём неизменны."""

    supplier: str | None = None
    price_per_m2: float | None = Field(default=None, gt=0)


class PurchaseRequestShopFloorCreate(BaseModel):
    """Заявка "с цеха" (раздел про замену "Заказов покупателей") — с
    "Выдачи участку" по нехватке остатка под конкретную строку задания.
    Без supplier/price_per_m2 — их выбирает снабженец позже на "Закупках",
    как и у обычной заявки после создания."""

    material: str
    color: str
    thickness: float
    requested_area_m2: float = Field(gt=0)
    note: str | None = None


class PurchaseRequestFulfillRequest(BaseModel):
    """Привязка заявки к конкретной приёмке по УПД (раздел про ускорение
    приёмки) — закрывает заявку и запоминает, каким УПД она закрыта."""

    upd_number: str


class PurchaseRequestOut(BaseModel):
    id: int
    material: str
    color: str
    thickness: float
    requested_area_m2: float
    current_stock_m2: float
    note: str | None
    status: str
    origin: str
    linked_upd_number: str | None
    created_by: int
    created_at: datetime
    closed_at: datetime | None
    supplier: str | None
    price_per_m2: float | None
