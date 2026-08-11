import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.core.config import settings
from app.core.security import get_current_user, require_roles
from app.db.session import get_db
from app.models.dictionaries import Color, Manufacturer, Material, MaterialSku, SkuAnalog, Thickness
from app.schemas.dictionaries import (
    AnalogEntryOut,
    ColorOut,
    DictEntryUpdate,
    DuplicateCandidateOut,
    ManufacturerOut,
    MaterialOut,
    MaterialSkuCreate,
    MaterialSkuOut,
    MaterialSkuUpdate,
    SkuAnalogCreate,
    SkuWithAnalogsOut,
    ThicknessOut,
    ThicknessUpdate,
)
from app.services.analogs import (
    analog_sku_of,
    create_analog_link,
    get_stale_threshold_days,
    list_analog_links,
    sku_stale_days,
    sku_stock_m2,
)
from app.services.dict_admin import find_fuzzy_duplicates
from app.services.dictionaries import find_or_create_sku

router = APIRouter(tags=["dictionaries"])

manage_dicts = require_roles("logist")

_PHOTO_EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


def _update_name_entry(db: Session, model, entry_id: int, payload: DictEntryUpdate):
    obj = db.get(model, entry_id)
    if obj is None:
        raise HTTPException(404, "Значение справочника не найдено")
    if payload.name is not None:
        obj.name = payload.name
    if payload.is_active is not None:
        obj.is_active = payload.is_active
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Такое значение уже есть в справочнике")
    db.refresh(obj)
    return obj


def _duplicates_for(db: Session, model) -> list:
    entries = [(e.id, e.name) for e in db.query(model).all()]
    return find_fuzzy_duplicates(entries)


@router.get("/materials", response_model=list[MaterialOut])
def list_materials(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Material]:
    return db.query(Material).filter(Material.is_active).order_by(Material.name).all()


@router.get("/materials/all", response_model=list[MaterialOut])
def list_all_materials(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[Material]:
    return db.query(Material).order_by(Material.name).all()


@router.get("/materials/duplicates", response_model=list[DuplicateCandidateOut])
def material_duplicates(db: Session = Depends(get_db), user=Depends(manage_dicts)):
    return _duplicates_for(db, Material)


@router.patch("/materials/{material_id}", response_model=MaterialOut)
def update_material(
    material_id: int, payload: DictEntryUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> Material:
    return _update_name_entry(db, Material, material_id, payload)


@router.get("/colors", response_model=list[ColorOut])
def list_colors(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Color]:
    return db.query(Color).filter(Color.is_active).order_by(Color.name).all()


@router.get("/colors/all", response_model=list[ColorOut])
def list_all_colors(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[Color]:
    return db.query(Color).order_by(Color.name).all()


@router.get("/colors/duplicates", response_model=list[DuplicateCandidateOut])
def color_duplicates(db: Session = Depends(get_db), user=Depends(manage_dicts)):
    return _duplicates_for(db, Color)


@router.patch("/colors/{color_id}", response_model=ColorOut)
def update_color(
    color_id: int, payload: DictEntryUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> Color:
    return _update_name_entry(db, Color, color_id, payload)


@router.get("/thicknesses", response_model=list[ThicknessOut])
def list_thicknesses(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Thickness]:
    return db.query(Thickness).filter(Thickness.is_active).order_by(Thickness.value_mm).all()


@router.get("/thicknesses/all", response_model=list[ThicknessOut])
def list_all_thicknesses(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[Thickness]:
    return db.query(Thickness).order_by(Thickness.value_mm).all()


@router.patch("/thicknesses/{thickness_id}", response_model=ThicknessOut)
def update_thickness(
    thickness_id: int, payload: ThicknessUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> Thickness:
    obj = db.get(Thickness, thickness_id)
    if obj is None:
        raise HTTPException(404, "Значение справочника не найдено")
    if payload.value_mm is not None:
        obj.value_mm = payload.value_mm
    if payload.is_active is not None:
        obj.is_active = payload.is_active
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Такое значение уже есть в справочнике")
    db.refresh(obj)
    return obj


@router.get("/manufacturers", response_model=list[ManufacturerOut])
def list_manufacturers(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Manufacturer]:
    return db.query(Manufacturer).filter(Manufacturer.is_active).order_by(Manufacturer.name).all()


@router.get("/manufacturers/all", response_model=list[ManufacturerOut])
def list_all_manufacturers(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[Manufacturer]:
    return db.query(Manufacturer).order_by(Manufacturer.name).all()


@router.get("/manufacturers/duplicates", response_model=list[DuplicateCandidateOut])
def manufacturer_duplicates(db: Session = Depends(get_db), user=Depends(manage_dicts)):
    return _duplicates_for(db, Manufacturer)


@router.patch("/manufacturers/{manufacturer_id}", response_model=ManufacturerOut)
def update_manufacturer(
    manufacturer_id: int, payload: DictEntryUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> Manufacturer:
    return _update_name_entry(db, Manufacturer, manufacturer_id, payload)


@router.post("/material-skus", response_model=MaterialSkuOut, status_code=status.HTTP_201_CREATED)
def create_material_sku(
    payload: MaterialSkuCreate,
    db: Session = Depends(get_db),
    user=Depends(require_roles("operator_sklada", "logist")),
) -> MaterialSku:
    """Голая позиция без физической единицы (8.5 раздел бэклога доработок)
    — завести номенклатуру заранее, до фактической поставки."""
    sku = find_or_create_sku(
        db, material=payload.material, color=payload.color, thickness=payload.thickness, manufacturer=payload.manufacturer
    )
    if payload.supplier_code is not None:
        sku.supplier_code = payload.supplier_code
    if payload.native_width_mm is not None:
        sku.native_width_mm = payload.native_width_mm
    db.commit()
    db.refresh(sku)
    return sku


def _skus_query(db: Session):
    return db.query(MaterialSku).options(
        joinedload(MaterialSku.material),
        joinedload(MaterialSku.color),
        joinedload(MaterialSku.thickness),
        joinedload(MaterialSku.manufacturer),
    )


@router.get("/material-skus", response_model=list[MaterialSkuOut])
def list_material_skus(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[MaterialSku]:
    return _skus_query(db).filter(MaterialSku.is_active).all()


@router.get("/material-skus/all", response_model=list[MaterialSkuOut])
def list_all_material_skus(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[MaterialSku]:
    """Номенклатура целиком, включая архивные (1 раздел бэклога доработок,
    пояснение по разделу 6 — это и есть каталог позиций, справочники
    материала/цвета/толщины/производителя — только его 4 составляющих)."""
    return _skus_query(db).all()


@router.patch("/material-skus/{sku_id}", response_model=MaterialSkuOut)
def update_material_sku(
    sku_id: int, payload: MaterialSkuUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> MaterialSku:
    sku = db.get(MaterialSku, sku_id)
    if sku is None:
        raise HTTPException(404, "Позиция не найдена")
    if payload.supplier_code is not None:
        sku.supplier_code = payload.supplier_code
    if payload.native_width_mm is not None:
        sku.native_width_mm = payload.native_width_mm
    if payload.is_active is not None:
        sku.is_active = payload.is_active
    db.commit()
    db.refresh(sku)
    return _skus_query(db).filter(MaterialSku.id == sku_id).first()


def _get_sku_or_404(db: Session, sku_id: int) -> MaterialSku:
    sku = _skus_query(db).filter(MaterialSku.id == sku_id).first()
    if sku is None:
        raise HTTPException(404, "Позиция не найдена")
    return sku


def _analog_entry(db: Session, link: SkuAnalog, sku_id: int, stale_threshold_days: int) -> AnalogEntryOut:
    other = analog_sku_of(link, sku_id)
    stale_days = sku_stale_days(db, other.id, stale_threshold_days)
    return AnalogEntryOut(
        link_id=link.id,
        sku=other,
        note=link.note,
        stock_m2=sku_stock_m2(db, other.id),
        is_illiquid=stale_days is not None,
        stale_days=stale_days,
    )


@router.get("/material-skus/{sku_id}/analogs", response_model=SkuWithAnalogsOut)
def get_sku_analogs(sku_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)) -> SkuWithAnalogsOut:
    """Аналоги позиции с готовым сигналом неликвида (8 раздел обратной связи)
    — использует калькулятор продажника и админка номенклатуры."""
    sku = _get_sku_or_404(db, sku_id)
    threshold = get_stale_threshold_days(db)
    links = list_analog_links(db, sku_id)
    return SkuWithAnalogsOut(
        sku=sku,
        stock_m2=sku_stock_m2(db, sku_id),
        analogs=[_analog_entry(db, link, sku_id, threshold) for link in links],
    )


@router.post("/material-skus/{sku_id}/analogs", response_model=AnalogEntryOut, status_code=status.HTTP_201_CREATED)
def add_sku_analog(
    sku_id: int, payload: SkuAnalogCreate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> AnalogEntryOut:
    if payload.analog_sku_id == sku_id:
        raise HTTPException(400, "Позиция не может быть аналогом самой себе")
    _get_sku_or_404(db, sku_id)
    _get_sku_or_404(db, payload.analog_sku_id)
    link = create_analog_link(db, sku_id=sku_id, analog_sku_id=payload.analog_sku_id, note=payload.note)
    threshold = get_stale_threshold_days(db)
    return _analog_entry(db, link, sku_id, threshold)


@router.delete("/material-skus/{sku_id}/analogs/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_sku_analog(sku_id: int, link_id: int, db: Session = Depends(get_db), user=Depends(manage_dicts)) -> None:
    link = db.get(SkuAnalog, link_id)
    if link is None or sku_id not in (link.sku_id, link.analog_sku_id):
        raise HTTPException(404, "Связь не найдена")
    db.delete(link)
    db.commit()


@router.post("/material-skus/{sku_id}/photo", response_model=MaterialSkuOut)
async def upload_sku_photo(
    sku_id: int, file: UploadFile = File(...), db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> MaterialSku:
    """Фото плёнки на диске сервера (8 раздел обратной связи) — отдаётся
    статикой из main.py по /uploads, во внешнем хранилище нужды нет."""
    sku = db.get(MaterialSku, sku_id)
    if sku is None:
        raise HTTPException(404, "Позиция не найдена")
    ext = _PHOTO_EXTENSIONS.get(file.content_type)
    if ext is None:
        raise HTTPException(400, "Допустимы только изображения JPEG/PNG/WebP")

    upload_root = Path(settings.upload_dir) / "skus"
    upload_root.mkdir(parents=True, exist_ok=True)
    if sku.photo_path:
        (Path(settings.upload_dir) / sku.photo_path).unlink(missing_ok=True)

    relative_path = f"skus/{sku_id}_{uuid.uuid4().hex}{ext}"
    contents = await file.read()
    (Path(settings.upload_dir) / relative_path).write_bytes(contents)

    sku.photo_path = relative_path
    db.commit()
    db.refresh(sku)
    return _skus_query(db).filter(MaterialSku.id == sku_id).first()


@router.delete("/material-skus/{sku_id}/photo", response_model=MaterialSkuOut)
def delete_sku_photo(sku_id: int, db: Session = Depends(get_db), user=Depends(manage_dicts)) -> MaterialSku:
    sku = db.get(MaterialSku, sku_id)
    if sku is None:
        raise HTTPException(404, "Позиция не найдена")
    if sku.photo_path:
        (Path(settings.upload_dir) / sku.photo_path).unlink(missing_ok=True)
        sku.photo_path = None
        db.commit()
        db.refresh(sku)
    return _skus_query(db).filter(MaterialSku.id == sku_id).first()
