"""Типы изделий и их свойства (единая модель, пункты 1–2).

Тип — внутри вида номенклатуры (ГП → «Щитовая дверь»); свойства типа —
характеристики позиции (число / текст / да-нет / список); у списка варианты
со своими параметрами (серия → толщина каркаса…). Значения — у позиции.
Удалить то, что уже где-то заполнено, нельзя: понятная ошибка вместо тихой
потери значений."""

import re

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.items import view_items
from app.core.security import require_permission
from app.db.session import get_db
from app.models.items import (
    PROPERTY_VALUE_TYPES,
    Item,
    ItemKind,
    ItemProperty,
    ItemPropertyOption,
    ItemPropertyValue,
    ItemType,
)

router = APIRouter(tags=["item-types"])

manage_types = require_permission("production_tasks.manage", "materials.manage")

_OPTION_FIELD_TYPES = ("number", "text")


class OptionField(BaseModel):
    code: str
    name: str
    value_type: str = "number"


class PropertyOptionIn(BaseModel):
    id: int | None = None
    value: str
    params: dict[str, float | str | None] = {}
    is_active: bool = True


class PropertyOptionOut(PropertyOptionIn):
    id: int
    used: int = 0


class PropertyIn(BaseModel):
    name: str
    code: str | None = None
    value_type: str
    unit: str | None = None
    is_required: bool = False
    option_fields: list[OptionField] = []


class PropertyOut(BaseModel):
    id: int
    code: str
    name: str
    value_type: str
    unit: str | None
    is_required: bool
    sort_order: int
    option_fields: list[OptionField]
    options: list[PropertyOptionOut]
    used: int


class ItemTypeIn(BaseModel):
    kind_code: str
    name: str


class ItemTypeUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None


class ItemTypeOut(BaseModel):
    id: int
    kind_code: str
    kind_name: str
    name: str
    is_active: bool
    item_count: int
    properties: list[PropertyOut]


def _slug(name: str) -> str:
    """Код свойства из названия — на него будут ссылаться правила состава
    («ширина + 10»), поэтому читаемый, по-русски можно."""
    code = re.sub(r"[^0-9a-zа-яё]+", "_", name.strip().lower()).strip("_")
    return code[:64] or "svoystvo"


def _property_out(db: Session, p: ItemProperty) -> PropertyOut:
    used_by_option = dict(
        db.query(ItemPropertyValue.option_id, func.count())
        .filter(ItemPropertyValue.property_id == p.id, ItemPropertyValue.option_id.isnot(None))
        .group_by(ItemPropertyValue.option_id)
        .all()
    )
    used = db.query(func.count()).select_from(ItemPropertyValue).filter(ItemPropertyValue.property_id == p.id).scalar()
    return PropertyOut(
        id=p.id, code=p.code, name=p.name, value_type=p.value_type, unit=p.unit, is_required=p.is_required,
        sort_order=p.sort_order, option_fields=[OptionField(**f) for f in (p.option_fields or [])],
        options=[
            PropertyOptionOut(
                id=o.id, value=o.value, params=o.params or {}, is_active=o.is_active, used=used_by_option.get(o.id, 0)
            )
            for o in p.options
        ],
        used=used or 0,
    )


def _type_out(db: Session, t: ItemType) -> ItemTypeOut:
    count = db.query(func.count(Item.id)).filter(Item.type_id == t.id).scalar()
    return ItemTypeOut(
        id=t.id, kind_code=t.kind.code, kind_name=t.kind.name, name=t.name, is_active=t.is_active,
        item_count=count or 0, properties=[_property_out(db, p) for p in t.properties],
    )


def _get_type(db: Session, type_id: int) -> ItemType:
    t = db.get(ItemType, type_id)
    if t is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Тип не найден")
    return t


def _get_property(db: Session, property_id: int) -> ItemProperty:
    p = db.get(ItemProperty, property_id)
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Свойство не найдено")
    return p


def _validate_property(payload: PropertyIn) -> None:
    if payload.value_type not in PROPERTY_VALUE_TYPES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Неизвестный тип значения")
    if not payload.name.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите название свойства")
    codes = [f.code.strip() for f in payload.option_fields]
    if len(set(codes)) != len(codes) or any(not c for c in codes):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Параметры вариантов: коды должны быть заполнены и не повторяться")
    if any(f.value_type not in _OPTION_FIELD_TYPES for f in payload.option_fields):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Параметр варианта — число или текст")


@router.get("/item-types", response_model=list[ItemTypeOut])
def list_item_types(
    kind: str | None = Query(default=None), db: Session = Depends(get_db), user=Depends(view_items)
) -> list[ItemTypeOut]:
    q = db.query(ItemType).join(ItemKind, ItemKind.id == ItemType.kind_id)
    if kind:
        q = q.filter(ItemKind.code == kind)
    return [_type_out(db, t) for t in q.order_by(ItemKind.sort_order, ItemType.sort_order, ItemType.name)]


@router.post("/item-types", response_model=ItemTypeOut, status_code=status.HTTP_201_CREATED)
def create_item_type(payload: ItemTypeIn, db: Session = Depends(get_db), user=Depends(manage_types)) -> ItemTypeOut:
    kind = db.query(ItemKind).filter(ItemKind.code == payload.kind_code).first()
    if kind is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Вид номенклатуры не найден")
    name = " ".join(payload.name.split())
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите название типа")
    if db.query(ItemType.id).filter(ItemType.kind_id == kind.id, func.lower(ItemType.name) == name.lower()).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Такой тип уже есть")
    t = ItemType(kind_id=kind.id, name=name)
    db.add(t)
    db.commit()
    db.refresh(t)
    return _type_out(db, t)


@router.put("/item-types/{type_id}", response_model=ItemTypeOut)
def update_item_type(
    type_id: int, payload: ItemTypeUpdate, db: Session = Depends(get_db), user=Depends(manage_types)
) -> ItemTypeOut:
    t = _get_type(db, type_id)
    if payload.name is not None:
        name = " ".join(payload.name.split())
        if not name:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите название типа")
        clash = db.query(ItemType.id).filter(
            ItemType.kind_id == t.kind_id, func.lower(ItemType.name) == name.lower(), ItemType.id != t.id
        ).first()
        if clash:
            raise HTTPException(status.HTTP_409_CONFLICT, "Такой тип уже есть")
        t.name = name
    if payload.is_active is not None:
        t.is_active = payload.is_active
    db.commit()
    return _type_out(db, t)


@router.delete("/item-types/{type_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item_type(type_id: int, db: Session = Depends(get_db), user=Depends(manage_types)) -> None:
    t = _get_type(db, type_id)
    if db.query(Item.id).filter(Item.type_id == t.id).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "У типа есть позиции — уберите тип у них или отправьте тип в архив")
    db.delete(t)
    db.commit()


@router.post("/item-types/{type_id}/properties", response_model=PropertyOut, status_code=status.HTTP_201_CREATED)
def create_property(
    type_id: int, payload: PropertyIn, db: Session = Depends(get_db), user=Depends(manage_types)
) -> PropertyOut:
    t = _get_type(db, type_id)
    _validate_property(payload)
    code = _slug(payload.code or payload.name)
    if any(p.code == code for p in t.properties):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Свойство с кодом «{code}» уже есть у типа")
    p = ItemProperty(
        type_id=t.id, code=code, name=payload.name.strip(), value_type=payload.value_type,
        unit=(payload.unit or "").strip() or None, is_required=payload.is_required,
        sort_order=max((x.sort_order for x in t.properties), default=0) + 1,
        option_fields=[f.model_dump() for f in payload.option_fields] if payload.value_type == "list" else [],
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return _property_out(db, p)


@router.put("/item-properties/{property_id}", response_model=PropertyOut)
def update_property(
    property_id: int, payload: PropertyIn, db: Session = Depends(get_db), user=Depends(manage_types)
) -> PropertyOut:
    p = _get_property(db, property_id)
    _validate_property(payload)
    used = db.query(ItemPropertyValue.item_id).filter(ItemPropertyValue.property_id == p.id).first() is not None
    if used and payload.value_type != p.value_type:
        raise HTTPException(status.HTTP_409_CONFLICT, "Свойство уже заполнено у позиций — тип значения менять нельзя")
    if payload.code and _slug(payload.code) != p.code:
        code = _slug(payload.code)
        if db.query(ItemProperty.id).filter(ItemProperty.type_id == p.type_id, ItemProperty.code == code).first():
            raise HTTPException(status.HTTP_409_CONFLICT, f"Свойство с кодом «{code}» уже есть у типа")
        p.code = code
    p.name = payload.name.strip()
    p.value_type = payload.value_type
    p.unit = (payload.unit or "").strip() or None
    p.is_required = payload.is_required
    p.option_fields = [f.model_dump() for f in payload.option_fields] if payload.value_type == "list" else []
    db.commit()
    db.refresh(p)
    return _property_out(db, p)


@router.delete("/item-properties/{property_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_property(property_id: int, db: Session = Depends(get_db), user=Depends(manage_types)) -> None:
    p = _get_property(db, property_id)
    if db.query(ItemPropertyValue.item_id).filter(ItemPropertyValue.property_id == p.id).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Свойство уже заполнено у позиций — удалить нельзя")
    db.delete(p)
    db.commit()


@router.put("/item-properties/{property_id}/options", response_model=PropertyOut)
def replace_options(
    property_id: int, payload: list[PropertyOptionIn], db: Session = Depends(get_db), user=Depends(manage_types)
) -> PropertyOut:
    """Варианты списка целиком: правка на месте по id (значения у позиций
    ссылаются на вариант), новый — без id; убрать можно только вариант,
    который нигде не выбран."""
    p = _get_property(db, property_id)
    if p.value_type != "list":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Варианты — только у свойства-списка")
    field_codes = {f["code"] for f in (p.option_fields or [])}
    values = [" ".join(o.value.split()) for o in payload]
    if any(not v for v in values) or len({v.lower() for v in values}) != len(values):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Варианты должны быть заполнены и не повторяться")
    existing = {o.id: o for o in p.options}
    keep = {o.id for o in payload if o.id is not None}
    for oid, o in existing.items():
        if oid not in keep:
            if db.query(ItemPropertyValue.item_id).filter(ItemPropertyValue.option_id == oid).first():
                raise HTTPException(status.HTTP_409_CONFLICT, f"Вариант «{o.value}» выбран у позиций — уберите его там или отправьте в архив")
            p.options.remove(o)
            db.delete(o)
    db.flush()
    for i, (o, value) in enumerate(zip(payload, values), start=1):
        params = {k: v for k, v in (o.params or {}).items() if k in field_codes and v not in (None, "")}
        if o.id is not None:
            opt = existing.get(o.id)
            if opt is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Вариант не найден")
            opt.value, opt.params, opt.is_active, opt.sort_order = value, params, o.is_active, i
        else:
            p.options.append(ItemPropertyOption(value=value, params=params, is_active=o.is_active, sort_order=i))
    db.commit()
    db.refresh(p)
    return _property_out(db, p)


class ItemPropertiesOut(BaseModel):
    item_id: int
    kind_code: str
    type_id: int | None
    values: dict[int, float | str | bool | int | None]  # property_id → число/текст/да-нет/id варианта


class ItemPropertiesIn(BaseModel):
    type_id: int | None
    values: dict[int, float | str | bool | int | None] = Field(default_factory=dict)


def _read_values(db: Session, item: Item) -> dict[int, float | str | bool | int | None]:
    out: dict[int, float | str | bool | int | None] = {}
    props = {p.id: p for p in (item.type.properties if item.type else [])}
    for v in db.query(ItemPropertyValue).filter(ItemPropertyValue.item_id == item.id):
        p = props.get(v.property_id)
        if p is None:
            continue
        out[p.id] = {
            "number": float(v.value_number) if v.value_number is not None else None,
            "text": v.value_text,
            "bool": v.value_bool,
            "list": v.option_id,
        }[p.value_type]
    return out


@router.get("/items/{item_id}/properties", response_model=ItemPropertiesOut)
def get_item_properties(item_id: int, db: Session = Depends(get_db), user=Depends(view_items)) -> ItemPropertiesOut:
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    return ItemPropertiesOut(item_id=item.id, kind_code=item.kind.code, type_id=item.type_id, values=_read_values(db, item))


@router.put("/items/{item_id}/properties", response_model=ItemPropertiesOut)
def set_item_properties(
    item_id: int, payload: ItemPropertiesIn, db: Session = Depends(get_db), user=Depends(manage_types)
) -> ItemPropertiesOut:
    """Тип позиции и значения его свойств целиком. Смена типа снимает
    значения свойств прежнего типа."""
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    new_type = _get_type(db, payload.type_id) if payload.type_id is not None else None
    if new_type is not None and new_type.kind_id != item.kind_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Тип относится к другому виду номенклатуры")
    db.query(ItemPropertyValue).filter(ItemPropertyValue.item_id == item.id).delete()
    item.type_id = new_type.id if new_type else None
    if new_type is not None:
        missing = []
        for p in new_type.properties:
            raw = payload.values.get(p.id)
            if raw is None or raw == "":
                if p.is_required:
                    missing.append(p.name)
                continue
            v = ItemPropertyValue(item_id=item.id, property_id=p.id)
            try:
                if p.value_type == "number":
                    v.value_number = float(raw)
                elif p.value_type == "text":
                    v.value_text = str(raw).strip()[:255]
                elif p.value_type == "bool":
                    v.value_bool = bool(raw)
                else:
                    opt = db.get(ItemPropertyOption, int(raw))
                    if opt is None or opt.property_id != p.id:
                        raise ValueError
                    v.option_id = opt.id
            except (TypeError, ValueError) as e:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"«{p.name}»: неверное значение") from e
            db.add(v)
        if missing:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Заполните: " + ", ".join(missing))
    db.commit()
    db.refresh(item)
    return ItemPropertiesOut(item_id=item.id, kind_code=item.kind.code, type_id=item.type_id, values=_read_values(db, item))
