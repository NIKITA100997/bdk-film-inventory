from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.dictionaries import Part
from app.models.items import match_part_id
from app.models.part_units import PartReservation
from app.models.production import ProductionTask, ProductionTaskLine
from app.models.users import User
from app.models.areas import Area
from app.services.operation_roles import big_batch, film_stage
from app.models.production_orders import ProductionOrder
from app.services.production_orders import OrderError, attach_tasks_to_order
from app.services.pf_demand import PfDemandRow, compute_pf_demand, compute_pf_preview, reserves_by_part

router = APIRouter(prefix="/pf-demand", tags=["pf-demand"])

manage = require_permission("production_tasks.manage")
view = require_permission("production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view")
# Резерв виден и на остатках п/ф — там же, где их видит кладовщик п/ф.
view_stock = require_permission(
    "production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view", "part_storage.manage"
)


class PfDemandSourceOut(BaseModel):
    task_id: int
    task_name: str
    open_plan: float
    done: float
    remaining: float
    reserve_set: float
    reserved: float
    in_work: float
    shortage: float


class PfDemandOut(BaseModel):
    part_id: int
    part_name: str
    min_stock: float | None
    min_batch: float | None
    task_demand: float
    stock: float
    in_work: float
    need: float
    shortage: float
    suggested: float
    first_stage_id: int
    first_stage_name: str
    first_stage_area: str | None
    sources: list[PfDemandSourceOut]
    reserved: float
    free: float
    # Ламинация панели: участок по маршруту (прессы) и альтернатива — окутка
    # на Фабрике для крупной партии (от factory_min_pieces).
    lamination_area: str | None = None
    factory_area: str | None = None
    factory_min_pieces: float | None = None


class PfDemandTaskItem(BaseModel):
    part_id: int
    quantity_pieces: float = Field(gt=0)
    # Участок ламинации панели для этого задания (прессы / Фабрика); пусто — по маршруту.
    lamination_area: str | None = None


class PfDemandTasksCreate(BaseModel):
    items: list[PfDemandTaskItem] = Field(min_length=1)
    ship_date: date | None = None
    # Задание цеха, под которое производятся п/ф: сделанное уходит в его резерв.
    for_task_id: int | None = None


class PfPreviewItem(BaseModel):
    part_id: int | None = None
    part_name: str | None = None
    width_mm: float | None = None
    length_m: float | None = None
    quantity_pieces: float = Field(gt=0)


class PfPreviewIn(BaseModel):
    items: list[PfPreviewItem] = Field(min_length=1)


class PfReservationIn(BaseModel):
    task_id: int
    part_id: int
    # 0 — снять резерв.
    quantity_pieces: float = Field(ge=0)


class PfDemandTasksOut(BaseModel):
    task_ids: list[int]


@router.get("", response_model=list[PfDemandOut])
def list_pf_demand(
    task_ids: list[int] | None = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(view),
) -> list[PfDemandOut]:
    return [_out(row, db) for row in compute_pf_demand(db, task_ids)]


def _out(row: PfDemandRow, db: Session | None = None) -> PfDemandOut:
    extra = {}
    if db is not None:
        part = db.get(Part, row.part_id)
        lam = film_stage(part.stages) if part else None
        target, min_pieces = big_batch(db, lam.area) if lam is not None else (None, None)
        if target:
            extra = {"lamination_area": lam.area, "factory_area": target, "factory_min_pieces": min_pieces}
    return PfDemandOut(**{**row.__dict__, "sources": [PfDemandSourceOut(**s.__dict__) for s in row.sources], **extra})


class PartReserveOut(BaseModel):
    part_id: int
    stock: float
    reserved: float
    free: float
    tasks: list[PfDemandSourceOut]


@router.get("/reserves", response_model=list[PartReserveOut])
def list_reserves(db: Session = Depends(get_db), user: User = Depends(view_stock)) -> list[PartReserveOut]:
    """Резерв п/ф по деталям — для экранов остатков (только детали с резервом)."""
    return [
        PartReserveOut(**{**r.__dict__, "tasks": [PfDemandSourceOut(**s.__dict__) for s in r.tasks]})
        for r in reserves_by_part(db)
    ]


@router.post("/preview", response_model=list[PfDemandOut])
def preview_pf_demand(payload: PfPreviewIn, db: Session = Depends(get_db), user: User = Depends(view)) -> list[PfDemandOut]:
    """Обеспечение п/ф для задания, которое ещё только составляют: строки
    с деталью по ссылке или по названию (как при сохранении задания)."""
    items = []
    for it in payload.items:
        part_id = it.part_id
        if part_id is None and it.part_name:
            part_id = match_part_id(db, it.part_name, it.width_mm, it.length_m)
        if part_id is not None:
            items.append((part_id, it.quantity_pieces))
    return [_out(row) for row in compute_pf_preview(db, items)] if items else []


@router.put("/reservations", status_code=status.HTTP_204_NO_CONTENT)
def set_reservation(payload: PfReservationIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> None:
    """Резерв детали на задание цеха (штуки; 0 — снять). Больше остатка
    задания по детали в расчёте не действует — лишнее просто не учитывается."""
    task = db.get(ProductionTask, payload.task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Задание не найдено")
    if not task.is_active:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Задание в архиве — резерв не нужен")
    if db.get(Part, payload.part_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Деталь не найдена")
    res = db.query(PartReservation).filter_by(task_id=payload.task_id, part_id=payload.part_id).one_or_none()
    if payload.quantity_pieces <= 0:
        if res is not None:
            db.delete(res)
    elif res is None:
        db.add(PartReservation(
            task_id=payload.task_id, part_id=payload.part_id, quantity_pieces=payload.quantity_pieces, created_by=user.id
        ))
    else:
        res.quantity_pieces = payload.quantity_pieces
    db.commit()


@router.post("/tasks", response_model=PfDemandTasksOut, status_code=status.HTTP_201_CREATED)
def create_pf_tasks(
    payload: PfDemandTasksCreate, db: Session = Depends(get_db), user: User = Depends(manage)
) -> PfDemandTasksOut:
    """Задания цеха на производство п/ф — по всем операциям маршрута детали
    (как запуск заказа): задание на участок, строка на операцию. Последний
    этап многоэтапной детали — готовая деталь на хранении, не операция."""
    by_area: dict[str, list[tuple[Part, float, int]]] = defaultdict(list)
    missing_area: list[str] = []
    for item in payload.items:
        part = db.get(Part, item.part_id)
        if part is None or not part.stages:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"У детали #{item.part_id} не настроены этапы")
        stages = sorted(part.stages, key=lambda s: s.sequence_order)
        if len(stages) > 1:
            stages = stages[:-1]
        for stage in stages:
            if stage.area is None:
                missing_area.append(f"{part.name} ({stage.name})")
                continue
            area = stage.area
            if item.lamination_area and stage is film_stage(part.stages):
                if db.get(Area, item.lamination_area) is None:
                    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Участок ламинации не найден")
                area = item.lamination_area
            by_area[area].append((part, item.quantity_pieces, stage.id))
    if missing_area:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "У этапов не указан участок: " + ", ".join(missing_area) + " — настройте маршрут детали",
        )
    for_task = None
    if payload.for_task_id is not None:
        for_task = db.get(ProductionTask, payload.for_task_id)
        if for_task is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Задание, под которое делаются п/ф, не найдено")
    today = date.today().strftime("%d.%m.%Y")
    task_ids = []
    tasks: list[ProductionTask] = []
    for area, items in by_area.items():
        # Без задания-получателя это пополнение склада — срок «готово к».
        ship = f", готово к {payload.ship_date.strftime('%d.%m.%Y')}" if payload.ship_date else ""
        name = f"П/ф на склад от {today}{ship}"
        if for_task is not None:
            label = for_task.name or (for_task.product_model.name if for_task.product_model else "")
            name = f"П/ф под задание №{for_task.id} «{label}»"[:255]
        task = ProductionTask(
            area=area, name=name, is_active=True, created_by=user.id,
            for_task_id=for_task.id if for_task is not None else None,
        )
        for part, qty, stage_id in items:
            task.lines.append(
                ProductionTaskLine(
                    quantity_pieces=qty, part_stage_id=stage_id, part_id=part.id, part_name=part.name,
                    width_mm=part.width_mm or 0, length_m=0,
                )
            )
        db.add(task)
        db.flush()
        tasks.append(task)
        task_ids.append(task.id)
    # Задания на п/ф — внутри заказа: под задание — в его заказ, иначе новый.
    order_id = for_task.production_order_id if for_task is not None else None
    order_name = tasks[0].name if tasks else "Производство п/ф"
    try:
        attach_tasks_to_order(
            db, tasks, name=order_name, user_id=user.id, order_id=order_id,
            ship_date=payload.ship_date or (db.get(ProductionOrder, order_id).ship_date if order_id else None),
            # Не под чужое задание — пополнение остатка: заказ «на склад».
            kind="stock" if order_id is None else "customer",
        )
    except OrderError as e:
        if order_id is None:
            db.rollback()
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
        # Заказ того задания уже закрыт — свой заказ под п/ф, срок — как у него.
        attach_tasks_to_order(
            db, tasks, name=order_name, user_id=user.id,
            ship_date=payload.ship_date or db.get(ProductionOrder, order_id).ship_date or date.today(),
        )
    db.commit()
    return PfDemandTasksOut(task_ids=task_ids)
