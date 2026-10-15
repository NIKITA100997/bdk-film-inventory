"""Резерв плёнки под заказ (15.10): настройка, кнопка у срочного заказа
клиента, список закреплённого, снятие и перехват. Логика — services/film_reserve."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.customer_orders import CustomerOrder
from app.models.dictionaries import Color, Material
from app.models.film_reserve import RES_ACTIVE, RES_RELEASED, FilmReservation
from app.models.production import ProductionTaskLine
from app.models.units import MaterialUnit
from app.models.users import User
from app.services import film_reserve

router = APIRouter(prefix="/film-reserve", tags=["film-reserve"])
admin = require_permission("users.manage")
view = require_permission("units.issue", "production_tasks.manage", "production_tasks.view")
manage = require_permission("production_tasks.manage")
override = require_permission(film_reserve.OVERRIDE)


class SettingsIO(BaseModel):
    enabled: bool
    extra_pct: float = Field(ge=0, le=100)


class SettingsOut(SettingsIO):
    stats: dict  # факт брака/пусковых/сверх плана за 60 дней и предложенный запас


class ReserveResult(BaseModel):
    reserved_m2: float
    short_m2: float  # не нашлось на складе
    lines: int


class ReservationOut(BaseModel):
    id: int
    unit_id: int
    unit_label: str
    location_code: str | None
    length_m: float
    area_m2: float
    strip_width_mm: float | None
    task_line_id: int | None
    task_name: str | None
    customer_order_id: int | None
    invoice_no: str | None
    created_at: datetime
    spec_key: str
    film: str


class ReleaseIn(BaseModel):
    note: str = Field(min_length=1, max_length=200)


@router.get("/settings", response_model=SettingsOut)
def get_settings(db: Session = Depends(get_db), user: User = Depends(view)) -> SettingsOut:
    s = film_reserve.get_settings(db)
    return SettingsOut(enabled=bool(s.get("enabled")), extra_pct=float(s.get("extra_pct") or 0), stats=film_reserve.loss_stats(db))


@router.put("/settings", response_model=SettingsOut)
def put_settings(payload: SettingsIO, db: Session = Depends(get_db), user: User = Depends(admin)) -> SettingsOut:
    film_reserve.save_settings(db, payload.model_dump(), user.id)
    db.commit()
    return get_settings(db, user)


def _out(db: Session, rows: list[FilmReservation]) -> list[ReservationOut]:
    out = []
    for r in rows:
        u = db.get(MaterialUnit, r.unit_id)
        sku = u.material_sku
        ln = db.get(ProductionTaskLine, r.task_line_id) if r.task_line_id else None
        co = db.get(CustomerOrder, r.customer_order_id) if r.customer_order_id else None
        out.append(ReservationOut(
            id=r.id, unit_id=r.unit_id, unit_label=f"№{u.id} {db.get(Material, sku.material_id).name} {db.get(Color, sku.color_id).name} {float(u.width_mm):g} мм",
            location_code=u.location_code, length_m=float(r.length_m), area_m2=float(r.area_m2),
            strip_width_mm=float(r.strip_width_mm) if r.strip_width_mm is not None else None,
            task_line_id=r.task_line_id, task_name=((ln.task.name or f"Задание №{ln.task_id}") if ln is not None else None),
            customer_order_id=r.customer_order_id, invoice_no=co.invoice_no if co is not None else None, created_at=r.created_at,
            spec_key=f"{sku.material_id}-{sku.color_id}-{sku.thickness_id}",
            film=f"{db.get(Material, sku.material_id).name} {db.get(Color, sku.color_id).name}",
        ))
    return out


@router.get("", response_model=list[ReservationOut])
def list_reservations(customer_order_id: int | None = None, task_id: int | None = None, unit_id: int | None = None,
                      db: Session = Depends(get_db), user: User = Depends(view)) -> list[ReservationOut]:
    q = db.query(FilmReservation).filter(FilmReservation.status == RES_ACTIVE)
    if customer_order_id is not None:
        q = q.filter(FilmReservation.customer_order_id == customer_order_id)
    if task_id is not None:
        q = q.join(ProductionTaskLine, ProductionTaskLine.id == FilmReservation.task_line_id).filter(ProductionTaskLine.task_id == task_id)
    if unit_id is not None:
        q = q.filter(FilmReservation.unit_id == unit_id)
    return _out(db, q.order_by(FilmReservation.id).all())


@router.post("/customer-orders/{co_id}", response_model=ReserveResult)
def reserve_customer_order(co_id: int, db: Session = Depends(get_db), user: User = Depends(manage)) -> ReserveResult:
    if not film_reserve.enabled(db):
        raise HTTPException(status.HTTP_409_CONFLICT, "Резерв плёнки выключен в настройках")
    co = db.get(CustomerOrder, co_id)
    if co is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заказ не найден")
    res = film_reserve.reserve_customer_order(db, co, user.id)
    db.commit()
    return ReserveResult(**res)


@router.delete("/customer-orders/{co_id}")
def release_customer_order(co_id: int, db: Session = Depends(get_db), user: User = Depends(manage)) -> dict:
    n = film_reserve.release_customer_order(db, co_id, user.id, "снят вручную")
    db.commit()
    return {"released": n}


@router.post("/{res_id}/release")
def release_one(res_id: int, payload: ReleaseIn, db: Session = Depends(get_db), user: User = Depends(override)) -> dict:
    """Снять один резерв (начальник цеха) — например, чтобы отдать рулон
    другому заказу; кто и почему — в записи резерва."""
    r = db.get(FilmReservation, res_id)
    if r is None or r.status != RES_ACTIVE:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Активный резерв не найден")
    film_reserve._close([r], RES_RELEASED, user.id, f"снят: {payload.note}")
    db.commit()
    return {"released": 1}


class ReserveGroupOut(BaseModel):
    spec_key: str
    film: str
    stock_m2: float  # на складах, рулоны и штрипсы
    reserved_m2: float  # из них закреплено (площадь рулона, с обрезью)
    free_m2: float
    reservations: int


@router.get("/summary", response_model=list[ReserveGroupOut])
def reserve_summary(db: Session = Depends(get_db), user: User = Depends(view)) -> list[ReserveGroupOut]:
    """По плёнке (материал + цвет + толщина): на складе — в резерве — свободно.
    Только группы, где есть активный резерв."""
    from collections import defaultdict

    from app.models.dictionaries import Thickness
    from app.models.units import MaterialSku, UnitStatus

    reserved: dict[tuple, float] = defaultdict(float)
    count: dict[tuple, int] = defaultdict(int)
    for r, u in db.query(FilmReservation, MaterialUnit).join(MaterialUnit, MaterialUnit.id == FilmReservation.unit_id).filter(
        FilmReservation.status == RES_ACTIVE
    ):
        sku = u.material_sku
        g = (sku.material_id, sku.color_id, sku.thickness_id)
        reserved[g] += float(r.length_m) * float(u.width_mm) / 1000
        count[g] += 1
    if not reserved:
        return []
    stock: dict[tuple, float] = defaultdict(float)
    q = (
        db.query(MaterialSku.material_id, MaterialSku.color_id, MaterialSku.thickness_id, MaterialUnit.width_mm, MaterialUnit.length_m)
        .join(MaterialUnit, MaterialUnit.material_sku_id == MaterialSku.id)
        .filter(MaterialUnit.status == UnitStatus.NA_KHRANENII)
    )
    for m, c, t, w, l in q:
        if (m, c, t) in reserved:
            stock[(m, c, t)] += float(w) * float(l) / 1000
    out = []
    for g, rm2 in reserved.items():
        label = f"{db.get(Material, g[0]).name} {db.get(Color, g[1]).name} {float(db.get(Thickness, g[2]).value_mm):g} мм"
        out.append(ReserveGroupOut(
            spec_key=f"{g[0]}-{g[1]}-{g[2]}", film=label, stock_m2=round(stock[g], 2), reserved_m2=round(rm2, 2),
            free_m2=round(max(0.0, stock[g] - rm2), 2), reservations=count[g],
        ))
    out.sort(key=lambda r: r.free_m2)
    return out
