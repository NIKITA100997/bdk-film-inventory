"""Администрирование участков (раздел про адаптацию под планшет — "нужно
добавить администрирование участков, какие есть и т.п."). Тот же логист,
что управляет пользователями/ролями (`users.manage`), управляет и этим —
участки такая же орг-структура администрирования, отдельного права не
заводим — но только на изменение. Список участков (GET) нужен любому
аутентифицированному пользователю (раздел про выдачу без задания —
оператор склада без users.manage не видел ни одного участка в селекте
выдачи, потому что раньше GET был за тем же правом, что и запись)."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.sites import Site
from app.schemas.areas import AreaCreate, AreaOut, AreaUpdate
from app.services.areas import unique_area_code

router = APIRouter(tags=["areas"])

manage_areas = require_permission("users.manage")


@router.get("/areas", response_model=list[AreaOut])
def list_areas(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[Area]:
    return db.query(Area).order_by(Area.name).all()


def _validate_site_id(db: Session, site_id: int | None) -> None:
    if site_id is not None and db.get(Site, site_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Площадка не найдена")


@router.post("/areas", response_model=AreaOut, status_code=status.HTTP_201_CREATED)
def create_area(payload: AreaCreate, db: Session = Depends(get_db), user=Depends(manage_areas)) -> Area:
    if db.query(Area).filter(Area.name == payload.name).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Участок с таким названием уже есть")
    _validate_site_id(db, payload.site_id)
    area = Area(
        code=unique_area_code(db, payload.name),
        name=payload.name,
        is_active=True,
        site_id=payload.site_id,
        requires_daily_plan=payload.requires_daily_plan,
        requires_roll_on_report=payload.requires_roll_on_report,
    )
    db.add(area)
    db.commit()
    db.refresh(area)
    return area


@router.patch("/areas/{code}", response_model=AreaOut)
def update_area(code: str, payload: AreaUpdate, db: Session = Depends(get_db), user=Depends(manage_areas)) -> Area:
    area = db.get(Area, code)
    if area is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Участок не найден")
    if payload.name is not None:
        if db.query(Area).filter(Area.name == payload.name, Area.code != code).first():
            raise HTTPException(status.HTTP_409_CONFLICT, "Участок с таким названием уже есть")
        area.name = payload.name
    if payload.is_active is not None:
        area.is_active = payload.is_active
    if payload.site_id is not None:
        _validate_site_id(db, payload.site_id)
        area.site_id = payload.site_id
    if payload.requires_daily_plan is not None:
        area.requires_daily_plan = payload.requires_daily_plan
    if payload.requires_roll_on_report is not None:
        area.requires_roll_on_report = payload.requires_roll_on_report
    if payload.film_cut_on_site is not None:
        area.film_cut_on_site = payload.film_cut_on_site
    if payload.lead_days is not None:
        if not 0 <= payload.lead_days <= 30:
            raise HTTPException(status_code=422, detail="Срок операции — от 0 до 30 рабочих дней")
        area.lead_days = payload.lead_days
    if payload.capacity_per_shift is not None:
        if payload.capacity_per_shift < 0:
            raise HTTPException(status_code=422, detail="Мощность — не меньше нуля")
        area.capacity_per_shift = payload.capacity_per_shift or None
    if payload.shifts_per_day is not None:
        if not 1 <= payload.shifts_per_day <= 4:
            raise HTTPException(status_code=422, detail="Смен в день — от 1 до 4")
        area.shifts_per_day = payload.shifts_per_day
    if payload.film_allowance_mm is not None:
        if not 0 <= payload.film_allowance_mm <= 200:
            raise HTTPException(status_code=422, detail="Припуск плёнки — от 0 до 200 мм")
        area.film_allowance_mm = payload.film_allowance_mm or None
    if payload.big_batch_area is not None:
        if payload.big_batch_area and payload.big_batch_area == code:
            raise HTTPException(status_code=422, detail="Крупные партии — на другой участок, не на этот же")
        if payload.big_batch_area and db.get(Area, payload.big_batch_area) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Участок для крупных партий не найден")
        area.big_batch_area = payload.big_batch_area or None
    if payload.big_batch_min_pieces is not None:
        if payload.big_batch_min_pieces < 0:
            raise HTTPException(status_code=422, detail="Порог крупной партии — не меньше нуля")
        area.big_batch_min_pieces = payload.big_batch_min_pieces or None
    db.commit()
    db.refresh(area)
    return area
