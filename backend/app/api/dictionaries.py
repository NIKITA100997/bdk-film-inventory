import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.core.config import settings
from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.dictionaries import Color, Employee, Manufacturer, Material, MaterialSku, Part, SkuAnalog, Thickness
from app.models.events import MaterialEvent
from app.models.units import MaterialUnit, UnitStatus
from app.schemas.deletion_requests import DeleteResultOut
from app.schemas.dictionaries import (
    AnalogEntryOut,
    ColorOut,
    DictEntryUpdate,
    DuplicateCandidateOut,
    EmployeeOut,
    ManufacturerOut,
    MaterialOut,
    MaterialSkuCreate,
    MaterialSkuOut,
    MaterialSkuUpdate,
    NameCreate,
    PartCreate,
    PartOut,
    PartUpdate,
    SkuAnalogCreate,
    SkuWithAnalogsOut,
    ThicknessCreate,
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
from app.services.deletion_requests import request_deletion
from app.services.dict_admin import find_fuzzy_duplicates
from app.services.dictionaries import (
    color_in_use,
    find_or_create_sku,
    manufacturer_in_use,
    material_in_use,
    sync_part_to_task_lines,
    thickness_in_use,
)

router = APIRouter(tags=["dictionaries"])

manage_dicts = require_permission("materials.manage")

_PHOTO_EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


def _create_name_entry(db: Session, model, payload: NameCreate):
    """Раздел про добавление значений в справочники напрямую — до этого
    материал/цвет/производитель заводились только неявно (find_or_create
    при вводе где-то ещё, например при приёмке); этот путь для случая,
    когда нужное значение хочется завести заранее, не выходя со
    "Справочников" ради формы приёмки/позиции."""
    obj = model(name=payload.name, is_active=True)
    db.add(obj)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Такое значение уже есть в справочнике")
    db.refresh(obj)
    return obj


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


def _sku_count(db: Session, column, value_id: int) -> int:
    """Раздел про счётчики в справочнике — сколько позиций номенклатуры
    (MaterialSku) сейчас используют это значение материала/цвета/
    толщины/производителя, рядом с уже существующим in_use (та проверка
    смотрит ещё несколько таблиц ради безопасности удаления — здесь
    только позиции, ровно то, что спросил пользователь)."""
    return db.query(func.count(MaterialSku.id)).filter(column == value_id).scalar() or 0


@router.get("/materials", response_model=list[MaterialOut])
def list_materials(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Material]:
    return db.query(Material).filter(Material.is_active).order_by(Material.name).all()


@router.get("/materials/all", response_model=list[MaterialOut])
def list_all_materials(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[MaterialOut]:
    return [
        MaterialOut(
            id=m.id, name=m.name, is_active=m.is_active, in_use=material_in_use(db, m.id),
            sku_count=_sku_count(db, MaterialSku.material_id, m.id),
        )
        for m in db.query(Material).order_by(Material.name).all()
    ]


@router.get("/materials/duplicates", response_model=list[DuplicateCandidateOut])
def material_duplicates(db: Session = Depends(get_db), user=Depends(manage_dicts)):
    return _duplicates_for(db, Material)


@router.post("/materials", response_model=MaterialOut, status_code=status.HTTP_201_CREATED)
def create_material(payload: NameCreate, db: Session = Depends(get_db), user=Depends(manage_dicts)) -> Material:
    return _create_name_entry(db, Material, payload)


@router.patch("/materials/{material_id}", response_model=MaterialOut)
def update_material(
    material_id: int, payload: DictEntryUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> Material:
    return _update_name_entry(db, Material, material_id, payload)


@router.delete("/materials/{material_id}", response_model=DeleteResultOut)
def delete_material(material_id: int, db: Session = Depends(get_db), user=Depends(manage_dicts)) -> DeleteResultOut:
    """Настоящее удаление (не архив, как у MaterialSku) — раздел про чистку
    неиспользуемых записей справочника. Лёгкая справочная запись без своей
    истории событий, поэтому без ветки "заявка на удаление" для не-
    суперпользователей — уже гейтится materials.manage, как и PATCH."""
    obj = db.get(Material, material_id)
    if obj is None:
        raise HTTPException(404, "Материал не найден")
    if material_in_use(db, material_id):
        raise HTTPException(409, "Нельзя удалить — используется в позициях номенклатуры/правилах/заданиях/заявках")
    db.delete(obj)
    db.commit()
    return DeleteResultOut(deleted=True, requested=False)


@router.get("/colors", response_model=list[ColorOut])
def list_colors(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Color]:
    return db.query(Color).filter(Color.is_active).order_by(Color.name).all()


@router.get("/colors/all", response_model=list[ColorOut])
def list_all_colors(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[ColorOut]:
    return [
        ColorOut(
            id=c.id, name=c.name, is_active=c.is_active, in_use=color_in_use(db, c.id),
            sku_count=_sku_count(db, MaterialSku.color_id, c.id),
        )
        for c in db.query(Color).order_by(Color.name).all()
    ]


@router.get("/colors/duplicates", response_model=list[DuplicateCandidateOut])
def color_duplicates(db: Session = Depends(get_db), user=Depends(manage_dicts)):
    return _duplicates_for(db, Color)


@router.post("/colors", response_model=ColorOut, status_code=status.HTTP_201_CREATED)
def create_color(payload: NameCreate, db: Session = Depends(get_db), user=Depends(manage_dicts)) -> Color:
    return _create_name_entry(db, Color, payload)


@router.patch("/colors/{color_id}", response_model=ColorOut)
def update_color(
    color_id: int, payload: DictEntryUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> Color:
    return _update_name_entry(db, Color, color_id, payload)


@router.delete("/colors/{color_id}", response_model=DeleteResultOut)
def delete_color(color_id: int, db: Session = Depends(get_db), user=Depends(manage_dicts)) -> DeleteResultOut:
    obj = db.get(Color, color_id)
    if obj is None:
        raise HTTPException(404, "Цвет не найден")
    if color_in_use(db, color_id):
        raise HTTPException(409, "Нельзя удалить — используется в позициях номенклатуры/правилах/заданиях/заявках")
    db.delete(obj)
    db.commit()
    return DeleteResultOut(deleted=True, requested=False)


@router.get("/thicknesses", response_model=list[ThicknessOut])
def list_thicknesses(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Thickness]:
    return db.query(Thickness).filter(Thickness.is_active).order_by(Thickness.value_mm).all()


@router.get("/thicknesses/all", response_model=list[ThicknessOut])
def list_all_thicknesses(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[ThicknessOut]:
    return [
        ThicknessOut(
            id=t.id, value_mm=t.value_mm, is_active=t.is_active, in_use=thickness_in_use(db, t.id),
            sku_count=_sku_count(db, MaterialSku.thickness_id, t.id),
        )
        for t in db.query(Thickness).order_by(Thickness.value_mm).all()
    ]


@router.post("/thicknesses", response_model=ThicknessOut, status_code=status.HTTP_201_CREATED)
def create_thickness(payload: ThicknessCreate, db: Session = Depends(get_db), user=Depends(manage_dicts)) -> Thickness:
    obj = Thickness(value_mm=payload.value_mm, is_active=True)
    db.add(obj)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Такое значение уже есть в справочнике")
    db.refresh(obj)
    return obj


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


@router.delete("/thicknesses/{thickness_id}", response_model=DeleteResultOut)
def delete_thickness(thickness_id: int, db: Session = Depends(get_db), user=Depends(manage_dicts)) -> DeleteResultOut:
    obj = db.get(Thickness, thickness_id)
    if obj is None:
        raise HTTPException(404, "Значение справочника не найдено")
    if thickness_in_use(db, thickness_id):
        raise HTTPException(409, "Нельзя удалить — используется в позициях номенклатуры/правилах/заданиях/заявках")
    db.delete(obj)
    db.commit()
    return DeleteResultOut(deleted=True, requested=False)


@router.get("/manufacturers", response_model=list[ManufacturerOut])
def list_manufacturers(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Manufacturer]:
    return db.query(Manufacturer).filter(Manufacturer.is_active).order_by(Manufacturer.name).all()


@router.get("/manufacturers/all", response_model=list[ManufacturerOut])
def list_all_manufacturers(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[ManufacturerOut]:
    return [
        ManufacturerOut(
            id=m.id, name=m.name, is_active=m.is_active, in_use=manufacturer_in_use(db, m.id),
            sku_count=_sku_count(db, MaterialSku.manufacturer_id, m.id),
        )
        for m in db.query(Manufacturer).order_by(Manufacturer.name).all()
    ]


@router.get("/manufacturers/duplicates", response_model=list[DuplicateCandidateOut])
def manufacturer_duplicates(db: Session = Depends(get_db), user=Depends(manage_dicts)):
    return _duplicates_for(db, Manufacturer)


@router.post("/manufacturers", response_model=ManufacturerOut, status_code=status.HTTP_201_CREATED)
def create_manufacturer(payload: NameCreate, db: Session = Depends(get_db), user=Depends(manage_dicts)) -> Manufacturer:
    return _create_name_entry(db, Manufacturer, payload)


@router.patch("/manufacturers/{manufacturer_id}", response_model=ManufacturerOut)
def update_manufacturer(
    manufacturer_id: int, payload: DictEntryUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> Manufacturer:
    return _update_name_entry(db, Manufacturer, manufacturer_id, payload)


@router.delete("/manufacturers/{manufacturer_id}", response_model=DeleteResultOut)
def delete_manufacturer(manufacturer_id: int, db: Session = Depends(get_db), user=Depends(manage_dicts)) -> DeleteResultOut:
    obj = db.get(Manufacturer, manufacturer_id)
    if obj is None:
        raise HTTPException(404, "Производитель не найден")
    if manufacturer_in_use(db, manufacturer_id):
        raise HTTPException(409, "Нельзя удалить — используется в позициях номенклатуры/правилах")
    db.delete(obj)
    db.commit()
    return DeleteResultOut(deleted=True, requested=False)


@router.get("/employees", response_model=list[EmployeeOut])
def list_employees(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Employee]:
    return db.query(Employee).filter(Employee.is_active).order_by(Employee.name).all()


@router.get("/employees/all", response_model=list[EmployeeOut])
def list_all_employees(db: Session = Depends(get_db), user=Depends(manage_dicts)) -> list[Employee]:
    return db.query(Employee).order_by(Employee.name).all()


@router.get("/employees/duplicates", response_model=list[DuplicateCandidateOut])
def employee_duplicates(db: Session = Depends(get_db), user=Depends(manage_dicts)):
    return _duplicates_for(db, Employee)


@router.post("/employees", response_model=EmployeeOut, status_code=status.HTTP_201_CREATED)
def create_employee(payload: NameCreate, db: Session = Depends(get_db), user=Depends(manage_dicts)) -> Employee:
    return _create_name_entry(db, Employee, payload)


@router.patch("/employees/{employee_id}", response_model=EmployeeOut)
def update_employee(
    employee_id: int, payload: DictEntryUpdate, db: Session = Depends(get_db), user=Depends(manage_dicts)
) -> Employee:
    return _update_name_entry(db, Employee, employee_id, payload)


# Справочник деталей (раздел про выбор детали в задание) — гейтится
# production_tasks.manage, не materials.manage: логически относится к
# производству/BOM, тем же правом уже гейтится "Модели продукции" в
# навигации. Бесхитростный CRUD не через _create_name_entry/_update_name_entry
# — у Part числовые поля сверх имени, генерик рассчитан только на name.
manage_parts = require_permission("production_tasks.manage")


@router.get("/parts", response_model=list[PartOut])
def list_parts(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Part]:
    return db.query(Part).filter(Part.is_active).order_by(Part.name).all()


@router.get("/parts/all", response_model=list[PartOut])
def list_all_parts(db: Session = Depends(get_db), user=Depends(manage_parts)) -> list[Part]:
    return db.query(Part).order_by(Part.name).all()


@router.get("/parts/duplicates", response_model=list[DuplicateCandidateOut])
def part_duplicates(db: Session = Depends(get_db), user=Depends(manage_parts)):
    return _duplicates_for(db, Part)


@router.post("/parts", response_model=PartOut, status_code=status.HTTP_201_CREATED)
def create_part(payload: PartCreate, db: Session = Depends(get_db), user=Depends(manage_parts)) -> Part:
    obj = Part(
        name=payload.name,
        width_mm=payload.width_mm,
        length_m=payload.length_m,
        strip_width_mm=payload.strip_width_mm,
        area=payload.area,
    )
    db.add(obj)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Деталь с таким названием уже есть в справочнике")
    db.refresh(obj)
    return obj


@router.patch("/parts/{part_id}", response_model=PartOut)
def update_part(part_id: int, payload: PartUpdate, db: Session = Depends(get_db), user=Depends(manage_parts)) -> Part:
    obj = db.get(Part, part_id)
    if obj is None:
        raise HTTPException(404, "Деталь не найдена")
    previous_name = obj.name
    if payload.name is not None:
        obj.name = payload.name
    if payload.width_mm is not None:
        obj.width_mm = payload.width_mm
    if payload.length_m is not None:
        obj.length_m = payload.length_m
    if payload.strip_width_mm is not None:
        obj.strip_width_mm = payload.strip_width_mm
    if "area" in payload.model_fields_set:
        # В отличие от полей выше — area можно осознанно очистить обратно
        # в "общая для всех участков" (null), поэтому здесь смотрим, было
        # ли поле явно передано в запросе, а не просто "не null".
        obj.area = payload.area
    if payload.is_active is not None:
        obj.is_active = payload.is_active
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Деталь с таким названием уже есть в справочнике")
    db.refresh(obj)
    # Раздел про правку детали "на лету" — см. sync_part_to_task_lines:
    # тянем новые размеры сразу в ещё нетронутые строки уже созданных
    # активных заданий, не дожидаясь следующей загрузки/пересоздания.
    synced = sync_part_to_task_lines(db, obj, previous_name)
    if synced:
        db.commit()
    obj.synced_task_lines = len(synced)
    return obj


@router.post("/material-skus", response_model=MaterialSkuOut, status_code=status.HTTP_201_CREATED)
def create_material_sku(
    payload: MaterialSkuCreate,
    db: Session = Depends(get_db),
    user=Depends(require_permission("units.receive", "materials.manage")),
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
def list_material_skus(
    in_stock_only: bool = False, db: Session = Depends(get_db), user=Depends(get_current_user)
) -> list[MaterialSku]:
    """in_stock_only (раздел про нулевые позиции при выдаче) — сужает до
    позиций, у которых реально есть остаток "На хранении" прямо сейчас;
    без этого в ручном подборе на выдаче можно было выбрать позицию, у
    которой физически нечего выдавать."""
    query = _skus_query(db).filter(MaterialSku.is_active)
    if in_stock_only:
        in_stock_ids = db.query(MaterialUnit.material_sku_id).filter(MaterialUnit.status == UnitStatus.NA_KHRANENII).distinct()
        query = query.filter(MaterialSku.id.in_(in_stock_ids))
    return query.all()


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


def delete_material_sku_impl(db: Session, sku: MaterialSku) -> None:
    """Раздел про удаление сущностей — позицию с историей (единицы,
    аналоги, журнал движений) удалить нельзя, только в архив: удаление
    физически стёрло бы часть учёта плёнки, а не просто убрало
    неиспользуемую карточку."""
    has_history = (
        db.query(MaterialUnit.id).filter(MaterialUnit.material_sku_id == sku.id).first() is not None
        or db.query(SkuAnalog.id).filter((SkuAnalog.sku_id == sku.id) | (SkuAnalog.analog_sku_id == sku.id)).first() is not None
        or db.query(MaterialEvent.event_id).filter(MaterialEvent.material_sku_id == sku.id).first() is not None
    )
    if has_history:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Нельзя удалить — есть история (единицы, аналоги или журнал движений). Отправьте в архив."
        )
    db.delete(sku)


@router.delete("/material-skus/{sku_id}", response_model=DeleteResultOut)
def delete_material_sku(sku_id: int, db: Session = Depends(get_db), user=Depends(manage_dicts)) -> DeleteResultOut:
    sku = _skus_query(db).filter(MaterialSku.id == sku_id).first()
    if sku is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    if not user.is_superuser:
        label = f"{sku.material.name}, {sku.color.name}, {float(sku.thickness.value_mm)} мм, {sku.manufacturer.name}"
        request_deletion(db, entity_type="material_sku", entity_id=sku.id, entity_label=label, requested_by=user.id)
        db.commit()
        return DeleteResultOut(deleted=False, requested=True)
    delete_material_sku_impl(db, sku)
    db.commit()
    return DeleteResultOut(deleted=True, requested=False)


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
