from pydantic import BaseModel, ConfigDict, Field


class MaterialOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    is_active: bool
    in_use: bool = False
    # Раздел про счётчики в справочнике — сколько позиций номенклатуры
    # (MaterialSku) сейчас используют это значение; отдельно от in_use
    # (та проверка перед удалением смотрит ещё MacroZoneRule/
    # WidthAbcClass/ProductionTaskLine/PurchaseRequest) — sku_count=0 не
    # означает in_use=false.
    sku_count: int = 0


class ColorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    is_active: bool
    in_use: bool = False
    # Раздел про счётчики в справочнике — сколько позиций номенклатуры
    # (MaterialSku) сейчас используют это значение; отдельно от in_use
    # (та проверка перед удалением смотрит ещё MacroZoneRule/
    # WidthAbcClass/ProductionTaskLine/PurchaseRequest) — sku_count=0 не
    # означает in_use=false.
    sku_count: int = 0


class ThicknessOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    value_mm: float
    is_active: bool
    in_use: bool = False
    # Раздел про счётчики в справочнике — сколько позиций номенклатуры
    # (MaterialSku) сейчас используют это значение; отдельно от in_use
    # (та проверка перед удалением смотрит ещё MacroZoneRule/
    # WidthAbcClass/ProductionTaskLine/PurchaseRequest) — sku_count=0 не
    # означает in_use=false.
    sku_count: int = 0


class ManufacturerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    is_active: bool
    in_use: bool = False
    # Раздел про счётчики в справочнике — сколько позиций номенклатуры
    # (MaterialSku) сейчас используют это значение; отдельно от in_use
    # (та проверка перед удалением смотрит ещё MacroZoneRule/
    # WidthAbcClass/ProductionTaskLine/PurchaseRequest) — sku_count=0 не
    # означает in_use=false.
    sku_count: int = 0


class EmployeeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    is_active: bool


class PartOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    width_mm: float
    length_m: float
    strip_width_mm: float | None
    area: str | None
    is_active: bool
    # Раздел про правку детали "на лету" — сколько строк ещё нетронутых
    # (без резки/отчёта/распределения) активных заданий подтянули новые
    # размеры прямо в момент этого сохранения (не сохраняется в БД, только
    # для тоста на фронте — см. sync_part_to_task_lines).
    synced_task_lines: int = 0


class PartCreate(BaseModel):
    name: str
    width_mm: float = Field(gt=0)
    length_m: float = Field(gt=0)
    strip_width_mm: float | None = Field(default=None, gt=0)
    area: str | None = None


class PartUpdate(BaseModel):
    name: str | None = None
    width_mm: float | None = Field(default=None, gt=0)
    length_m: float | None = Field(default=None, gt=0)
    strip_width_mm: float | None = Field(default=None, gt=0)
    area: str | None = None
    is_active: bool | None = None


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
