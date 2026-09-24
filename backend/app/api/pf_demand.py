from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.area_tasks import AreaTask, AreaTaskLine
from app.models.dictionaries import Part
from app.models.users import User
from app.services.pf_demand import compute_pf_demand

router = APIRouter(prefix="/pf-demand", tags=["pf-demand"])

manage = require_permission("production_tasks.manage")
view = require_permission("production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view")


class PfDemandSourceOut(BaseModel):
    task_id: int
    task_name: str
    open_plan: float
    done: float
    remaining: float


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


class PfDemandTaskItem(BaseModel):
    part_id: int
    quantity_pieces: float = Field(gt=0)


class PfDemandTasksCreate(BaseModel):
    items: list[PfDemandTaskItem] = Field(min_length=1)
    ship_date: date | None = None


class PfDemandTasksOut(BaseModel):
    task_ids: list[int]


@router.get("", response_model=list[PfDemandOut])
def list_pf_demand(
    task_ids: list[int] | None = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(view),
) -> list[PfDemandOut]:
    return [
        PfDemandOut(**{**row.__dict__, "sources": [PfDemandSourceOut(**s.__dict__) for s in row.sources]})
        for row in compute_pf_demand(db, task_ids)
    ]


@router.post("/tasks", response_model=PfDemandTasksOut, status_code=status.HTTP_201_CREATED)
def create_pf_tasks(
    payload: PfDemandTasksCreate, db: Session = Depends(get_db), user: User = Depends(manage)
) -> PfDemandTasksOut:
    """Задания участкам на производство п/ф — одно задание на участок первого
    этапа, строка на деталь; дальше по этапам партии идут отчётами."""
    by_area: dict[str, list[tuple[Part, float, int]]] = defaultdict(list)
    missing_area: list[str] = []
    for item in payload.items:
        part = db.get(Part, item.part_id)
        if part is None or not part.stages:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"У детали #{item.part_id} не настроены этапы")
        first = min(part.stages, key=lambda s: s.sequence_order)
        if first.area is None:
            missing_area.append(part.name)
            continue
        by_area[first.area].append((part, item.quantity_pieces, first.id))
    if missing_area:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "У первого этапа не указан участок: " + ", ".join(missing_area) + " — настройте в справочнике деталей",
        )
    today = date.today().strftime("%d.%m.%Y")
    task_ids = []
    for area, items in by_area.items():
        task = AreaTask(
            area=area, name=f"Производство п/ф от {today}", source="pf_demand", ship_date=payload.ship_date,
            is_active=True, created_by=user.id,
        )
        for i, (part, qty, stage_id) in enumerate(items):
            task.lines.append(AreaTaskLine(sort_order=i, name=part.name, quantity_pieces=qty, part_stage_id=stage_id))
        db.add(task)
        db.flush()
        task_ids.append(task.id)
    db.commit()
    return PfDemandTasksOut(task_ids=task_ids)
