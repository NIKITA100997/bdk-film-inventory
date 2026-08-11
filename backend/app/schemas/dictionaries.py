from pydantic import BaseModel, ConfigDict


class MaterialOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    is_active: bool


class ColorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    is_active: bool


class ThicknessOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    value_mm: float
    is_active: bool


class ManufacturerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    is_active: bool


class MaterialSkuOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    material: MaterialOut
    color: ColorOut
    thickness: ThicknessOut
    manufacturer: ManufacturerOut
    supplier_code: str | None
    native_width_mm: float | None
    photo_path: str | None
    is_active: bool


class NameCreate(BaseModel):
    name: str


class ThicknessCreate(BaseModel):
    value_mm: float


class MaterialSkuCreate(BaseModel):
    material: str
    color: str
    thickness: float
    manufacturer: str
    supplier_code: str | None = None
    native_width_mm: float | None = None


class MaterialSkuUpdate(BaseModel):
    supplier_code: str | None = None
    native_width_mm: float | None = None
    is_active: bool | None = None


class DictEntryUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None


class ThicknessUpdate(BaseModel):
    value_mm: float | None = None
    is_active: bool | None = None


class DuplicateCandidateOut(BaseModel):
    a_id: int
    a_name: str
    b_id: int
    b_name: str
    score: float


class SkuAnalogCreate(BaseModel):
    analog_sku_id: int
    note: str | None = None


class AnalogEntryOut(BaseModel):
    """Одна строка аналога с готовым сигналом неликвида — калькулятору
    продажника и админке номенклатуры не нужно считать это самим (8 раздел
    обратной связи)."""

    link_id: int
    sku: MaterialSkuOut
    note: str | None
    stock_m2: float
    is_illiquid: bool
    stale_days: int | None


class SkuWithAnalogsOut(BaseModel):
    sku: MaterialSkuOut
    stock_m2: float
    analogs: list[AnalogEntryOut]
