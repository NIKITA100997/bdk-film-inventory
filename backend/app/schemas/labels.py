from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.services.labels import FIELD_META, FIELD_META_RACK

# Раздел про этикетки стеллажей/полок — один и тот же LabelFieldConfig
# используется для обоих макетов (unit и rack), поэтому проверяем key по
# объединению обоих реестров полей, не только FIELD_META.
_ALL_LABEL_FIELD_KEYS = set(FIELD_META) | set(FIELD_META_RACK)


class LabelFieldConfig(BaseModel):
    key: str
    size: str = "sm"  # sm/md/lg — игнорируется для kind=image/stripe
    bold: bool = False

    @model_validator(mode="after")
    def _valid_key_and_size(self):
        if self.key not in _ALL_LABEL_FIELD_KEYS:
            raise ValueError(f"Неизвестное поле этикетки: {self.key}")
        if self.size not in ("sm", "md", "lg"):
            raise ValueError("size должен быть sm, md или lg")
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


class RackLabelCellIn(BaseModel):
    """Место хранения для печати этикетки — фронтенд передаёт уже
    посчитанный список (тот же формат, что отдаёт GET /racks/{id}/occupancy),
    бэкенд не пересчитывает адресацию полок/ячеек второй раз."""

    shelf: int
    cell: int | None = None
    location_code: str


class RackLabelBatchRequest(BaseModel):
    cells: list[RackLabelCellIn] = Field(min_length=1)
