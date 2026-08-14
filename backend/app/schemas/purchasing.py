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
    order_id: int | None


class SupplierOrderCreate(BaseModel):
    """Объединение нескольких заявок в один заказ поставщику (раздел про
    экран снабженца) — заявки остаются отдельными записями, только
    получают общий order_id и supplier_id."""

    supplier: str
    request_ids: list[int] = Field(min_length=1)
    note: str | None = None


class SupplierOrderLineOut(BaseModel):
    """Заявки одной номенклатуры внутри заказа показаны одной строкой с
    суммой — сама группировка на уровне ответа API, не в БД (заявки
    остаются раздельными)."""

    material: str
    color: str
    thickness: float
    requested_area_m2: float
    current_stock_m2: float
    request_ids: list[int]


class SupplierOrderOut(BaseModel):
    id: int
    supplier: str
    note: str | None
    created_by: int
    created_at: datetime
    # Не хранится — открыт, пока среди заявок заказа есть хоть одна open.
    is_open: bool
    lines: list[SupplierOrderLineOut]


class StockOverviewLine(BaseModel):
    """«Остатки и резерв» (раздел про экран снабженца) — остаток на
    складе, сколько из него уже нужно текущим (незавершённым) заданиям
    цеха и сколько уже в открытых заявках, чтобы не заказать повторно."""

    material: str
    color: str
    thickness: float
    total_area_m2: float
    reserved_area_m2: float
    open_requested_area_m2: float
    usual_supplier: str | None
