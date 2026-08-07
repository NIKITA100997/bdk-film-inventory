from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.dictionaries import MaterialSku
from app.models.events import MaterialEvent
from app.models.plans import FilmRequestLine, WeeklyPlan
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.schemas.material_cards import MaterialCardOut
from app.schemas.plans import PlanFactLine
from app.services.plan_fact import fetch_actual_for_group

router = APIRouter(prefix="/material-cards", tags=["material-cards"])


@router.get("/{sku_id}", response_model=MaterialCardOut)
def get_material_card(sku_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> MaterialCardOut:
    """Карточка материала (2.6 ТЗ) — сгруппировано по конкретной позиции
    (SKU): материал+цвет+толщина+производитель."""
    sku = (
        db.query(MaterialSku)
        .options(
            joinedload(MaterialSku.material),
            joinedload(MaterialSku.color),
            joinedload(MaterialSku.thickness),
            joinedload(MaterialSku.manufacturer),
        )
        .filter(MaterialSku.id == sku_id)
        .first()
    )
    if sku is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Позиция материала не найдена")

    units = (
        db.query(MaterialUnit)
        .options(
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.material),
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.color),
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.thickness),
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.manufacturer),
        )
        .filter(MaterialUnit.material_sku_id == sku_id, MaterialUnit.status != UnitStatus.SPISAN)
        .order_by(MaterialUnit.width_mm.desc())
        .all()
    )
    total_area_m2 = round(sum(float(u.width_mm) * float(u.length_m) / 1000 for u in units), 3)

    events = (
        db.query(MaterialEvent)
        .filter(MaterialEvent.material_sku_id == sku_id)
        .order_by(MaterialEvent.timestamp.desc())
        .limit(50)
        .all()
    )

    # План/факт (2.6 ТЗ): берём самый свежий план, покрывающий сегодняшнюю
    # дату, у которого есть позиция с этим material/color/thickness.
    today = date.today()
    plan_fact_line: PlanFactLine | None = None
    line = (
        db.query(FilmRequestLine)
        .join(WeeklyPlan, FilmRequestLine.weekly_plan_id == WeeklyPlan.id)
        .filter(
            FilmRequestLine.material_id == sku.material_id,
            FilmRequestLine.color_id == sku.color_id,
            FilmRequestLine.thickness_id == sku.thickness_id,
            WeeklyPlan.week_start <= today,
            WeeklyPlan.week_end >= today,
        )
        .order_by(WeeklyPlan.week_start.desc())
        .first()
    )
    if line is not None:
        actual = fetch_actual_for_group(
            db,
            material_id=sku.material_id,
            color_id=sku.color_id,
            thickness_id=sku.thickness_id,
            date_from=line.weekly_plan.week_start,
            date_to=line.weekly_plan.week_end,
        )
        planned = float(line.planned_area_m2)
        plan_fact_line = PlanFactLine(
            line_id=line.id,
            material=sku.material.name,
            color=sku.color.name,
            thickness=float(sku.thickness.value_mm),
            planned_area_m2=planned,
            actual_area_m2=actual.total_area_m2,
            percent_complete=round(actual.total_area_m2 / planned * 100, 1) if planned else 0,
            by_width=actual.by_width,
        )

    return MaterialCardOut(
        sku=sku,
        total_area_m2=total_area_m2,
        units=units,
        plan_fact=plan_fact_line,
        events=events,
    )
