from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.services.labels import FIELD_META, FIELD_META_RACK, FIELD_META_SHELF

# Раздел про этикетки стеллажей/полок — один и тот же LabelFieldConfig
# используется для всех трёх макетов (unit, rack, shelf), поэтому
# проверяем key по объединению всех реестров полей, не только FIELD_META.
_ALL_LABEL_FIELD_KEYS = set(FIELD_META) | set(FIELD_META_RACK) | set(FIELD_META_SHELF)


class LabelFieldConfig(BaseModel):
    key: str
    size: str = "sm"  # sm/md/lg/huge — игнорируется для kind=image/stripe
    bold: bool = False
    # Раздел про огромный номер на этикетке места хранения — "цифры друг
    # над другом", по одному символу на строку. Осмысленно только при
    # size="huge"; при других размерах просто ни на что не влияет.
    vertical: bool = False

    @model_validator(mode="after")
    def _valid_key_and_size(self):
        if self.key not in _ALL_LABEL_FIELD_KEYS:
            raise ValueError(f"Неизвестное поле этикетки: {self.key}")
        if self.size not in ("sm", "md", "lg", "huge"):
            raise ValueError("size должен быть sm, md, lg или huge")
        return self


class LabelTemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    width_mm: int
    height_mm: int
    fields: list[LabelFieldConfig]


class LabelTemplateUpdate(BaseModel):
    width_mm: int = Field(gt=0)
    height_mm: int = Field(gt=0)
    fields: list[LabelFieldConfig]


class AvailableFieldOut(BaseModel):
    key: str
    label: str
    kind: str
    stale_warning: bool = False


class LabelBatchRequest(BaseModel):
    unit_ids: list[int] = Field(min_length=1)


class ShelfLabelCellIn(BaseModel):
    """Место хранения для печати этикетки — фронтенд передаёт уже
    посчитанный список (тот же формат, что отдаёт GET /racks/{id}/occupancy),
    бэкенд не пересчитывает адресацию полок/ячеек второй раз."""

    shelf: int
    location_code: str


class ShelfLabelBatchRequest(BaseModel):
    cells: list[ShelfLabelCellIn] = Field(min_length=1)
