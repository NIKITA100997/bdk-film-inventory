from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.services.labels import FIELD_META


class LabelFieldConfig(BaseModel):
    key: str
    size: str = "sm"  # sm/md/lg — игнорируется для kind=image/stripe
    bold: bool = False

    @model_validator(mode="after")
    def _valid_key_and_size(self):
        if self.key not in FIELD_META:
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
