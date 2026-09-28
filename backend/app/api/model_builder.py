"""Конструктор моделей: подсказки, новая модель, варианты пачкой, дерево
техкарты (services/model_builder.py)."""

from dataclasses import asdict
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.item_types import _get_type, manage_types
from app.api.items import view_items
from app.db.session import get_db
from app.models.items import Item, ItemPropertyOption
from app.services import model_builder
from app.services.model_summary import model_summary

router = APIRouter(tags=["model-builder"])

Value = float | str | bool | int | None


class HintOut(BaseModel):
    value: Value
    count: int


class HintsOut(BaseModel):
    properties: dict[int, list[HintOut]]
    option_fields: dict[int, dict[str, list[HintOut]]]


@router.get("/item-types/{type_id}/hints", response_model=HintsOut)
def type_hints(type_id: int, db: Session = Depends(get_db), user=Depends(view_items)) -> HintsOut:
    """Частые значения свойств вариантов и параметров моделей типа."""
    return HintsOut(**model_builder.value_hints(db, _get_type(db, type_id)))


class ModelIn(BaseModel):
    value: str
    params: dict[str, float | str | None] = {}


class ModelOut(BaseModel):
    option_id: int
    model_item_id: int
    name: str


@router.post("/item-types/{type_id}/models", response_model=ModelOut, status_code=status.HTTP_201_CREATED)
def create_model(type_id: int, payload: ModelIn, db: Session = Depends(get_db), user=Depends(manage_types)) -> ModelOut:
    """Новая модель (серия) типа — вариант свойства-модели с параметрами и
    позиция-модель; варианты к ней — отдельно."""
    t = _get_type(db, type_id)
    try:
        option, model = model_builder.add_model(db, t, payload.value, payload.params)
    except ValueError as e:
        db.rollback()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    return ModelOut(option_id=option.id, model_item_id=model.id, name=model.name)


class BatchIn(BaseModel):
    # property_id → выбранные значения (сочетания всех со всеми)
    choices: dict[int, list[Value]] = Field(default_factory=dict)
    create: bool = False


class BatchRowOut(BaseModel):
    values: dict[int, Value]
    name: str | None
    status: str
    item_id: int | None
    errors: list[str]


class BatchOut(BaseModel):
    rows: list[BatchRowOut]
    total: int
    truncated: bool


@router.post("/item-types/{type_id}/variants", response_model=BatchOut)
def variants_batch(type_id: int, payload: BatchIn, db: Session = Depends(get_db), user=Depends(view_items)) -> BatchOut:
    """Варианты пачкой: все сочетания выбранных значений. create=false —
    предпросмотр (название, есть ли уже, ошибки), create=true — создать
    (нужно право на номенклатуру)."""
    t = _get_type(db, type_id)
    if payload.create:
        # Право на создание — то же, что у «Новая позиция по типу».
        manage_types(user)  # type: ignore[call-arg]
    props = {p.id: p for p in t.properties}
    choices: dict[int, list] = {}
    for pid, vals in payload.choices.items():
        p = props.get(int(pid))
        if p is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Свойство не этого типа")
        clean = []
        for v in vals:
            if v in (None, ""):
                continue
            if p.value_type == "number":
                clean.append(float(v))
            elif p.value_type == "bool":
                clean.append(bool(v))
            elif p.value_type == "list":
                opt = db.get(ItemPropertyOption, int(v))
                if opt is None or opt.property_id != p.id:
                    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"«{p.name}»: неверное значение")
                clean.append(opt.id)
            else:
                clean.append(str(v).strip()[:255])
        choices[p.id] = list(dict.fromkeys(clean))
    rows = model_builder.combinations(t, choices)
    result = model_builder.batch(db, t, rows, create=payload.create)
    if payload.create:
        db.commit()
    else:
        db.rollback()
    return BatchOut(
        rows=[BatchRowOut(**{k: v for k, v in asdict(r).items()}) for r in result],
        total=len(rows),
        truncated=len(rows) > model_builder.MAX_BATCH,
    )


class TreeOperationOut(BaseModel):
    name: str
    area: str | None
    area_name: str | None
    components: list["TreeNodeOut"]


class TreeNodeOut(BaseModel):
    name: str
    kind_code: str | None
    item_id: int | None
    exists: bool
    qty: float | None
    unit: str | None
    operations: list[TreeOperationOut]
    loose: list["TreeNodeOut"]
    warnings: list[str]


TreeOperationOut.model_rebuild()


@router.get("/items/{item_id}/tree", response_model=TreeNodeOut)
def item_tree(item_id: int, db: Session = Depends(get_db), user=Depends(view_items)) -> TreeNodeOut:
    """Дерево техкарты позиции вглубь — для схемы."""
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    return TreeNodeOut(**asdict(model_builder.item_tree(db, item)))


class TreePreviewIn(BaseModel):
    values: dict[int, Value] = Field(default_factory=dict)


@router.post("/item-types/{type_id}/tree", response_model=TreeNodeOut)
def preview_tree(type_id: int, payload: TreePreviewIn, db: Session = Depends(get_db), user=Depends(view_items)) -> TreeNodeOut:
    """Дерево позиции, которой ещё нет, — по правилам типа."""
    t = _get_type(db, type_id)
    values = {int(k): v for k, v in payload.values.items() if v not in (None, "")}
    return TreeNodeOut(**asdict(model_builder.preview_tree(db, t, values)))


class VariantStatOut(BaseModel):
    item_id: int
    name: str
    is_active: bool
    values: dict[str, str]
    ordered: float
    done: float
    defect: float
    in_work: float
    draft: float
    orders: int
    last_order_at: datetime | None


class ValueStatOut(BaseModel):
    value: str
    variants: int
    ordered: float


class ModelSummaryOut(BaseModel):
    model_id: int
    variants: list[VariantStatOut]
    totals: dict[str, float]
    by_property: dict[str, list[ValueStatOut]]
    order_ids: list[int]


@router.get("/items/{item_id}/model-summary", response_model=ModelSummaryOut)
def get_model_summary(item_id: int, db: Session = Depends(get_db), user=Depends(view_items)) -> ModelSummaryOut:
    """Общая история модели: варианты вместе — заказано, сделано, брак, в
    работе; какие цвета и размеры заказывают чаще."""
    model = db.get(Item, item_id)
    if model is None or not model.is_model:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Модель не найдена")
    return ModelSummaryOut(**asdict(model_summary(db, model)))
