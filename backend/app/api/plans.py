from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_roles
from app.db.session import get_db
from app.models.dictionaries import Color, Material, MaterialSku, Thickness
from app.models.plans import FilmRequestLine, WeeklyPlan
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.schemas.plans import (
    FilmRequestLineCreate,
    FilmRequestLineOut,
    PlanFactLine,
    PlanFactOut,
    WeeklyPlanCreate,
    WeeklyPlanOut,
)
from app.services.dictionaries import find_or_create_material_color_thickness
from app.services.plan_fact import fetch_actual_for_group

router = APIRouter(tags=["plans"])

manage_plans = require_roles("nachalnik_tsekha")


def _current_stock_m2(db: Session, material_id: int, color_id: int, thickness_id: int) -> float:
    """Σ area_m2 по всем единицам этой группы material+color+thickness
    (без учёта производителя — заявка на плёнку не привязана к нему, 2.7
    ТЗ), кроме списанных."""
    total = (
        db.query(func.sum(MaterialUnit.width_mm * MaterialUnit.length_m))
        .join(MaterialSku, MaterialUnit.material_sku_id == MaterialSku.id)
        .filter(
            MaterialSku.material_id == material_id,
            MaterialSku.color_id == color_id,
            MaterialSku.thickness_id == thickness_id,
            MaterialUnit.status != UnitStatus.SPISAN,
        )
        .scalar()
    )
    return round(float(total or 0) / 1000, 3)


def _line_out(db: Session, line: FilmRequestLine) -> FilmRequestLineOut:
    stock = _current_stock_m2(db, line.material_id, line.color_id, line.thickness_id)
    return FilmRequestLineOut(
        id=line.id,
        material=db.get(Material, line.material_id).name,
        color=db.get(Color, line.color_id).name,
        thickness=float(db.get(Thickness, line.thickness_id).value_mm),
        planned_area_m2=float(line.planned_area_m2),
        current_stock_m2=stock,
        shortage=stock < float(line.planned_area_m2),
    )


def _plan_out(db: Session, plan: WeeklyPlan) -> WeeklyPlanOut:
    return WeeklyPlanOut(
        id=plan.id,
        week_start=plan.week_start,
        week_end=plan.week_end,
        created_by=plan.created_by,
        status=plan.status,
        lines=[_line_out(db, line) for line in plan.lines],
    )


@router.post("/weekly-plans", response_model=WeeklyPlanOut, status_code=status.HTTP_201_CREATED)
def create_plan(payload: WeeklyPlanCreate, db: Session = Depends(get_db), user: User = Depends(manage_plans)) -> WeeklyPlanOut:
    plan = WeeklyPlan(week_start=payload.week_start, week_end=payload.week_end, created_by=user.id, status="active")
    db.add(plan)
    db.commit()
    db.refresh(plan)
    return _plan_out(db, plan)


@router.get("/weekly-plans", response_model=list[WeeklyPlanOut])
def list_plans(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[WeeklyPlanOut]:
    plans = db.query(WeeklyPlan).order_by(WeeklyPlan.week_start.desc()).limit(50).all()
    return [_plan_out(db, p) for p in plans]


@router.get("/weekly-plans/{plan_id}", response_model=WeeklyPlanOut)
def get_plan(plan_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> WeeklyPlanOut:
    plan = db.get(WeeklyPlan, plan_id)
    if plan is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="План не найден")
    return _plan_out(db, plan)


@router.post("/weekly-plans/{plan_id}/lines", response_model=FilmRequestLineOut, status_code=status.HTTP_201_CREATED)
def add_line(
    plan_id: int,
    payload: FilmRequestLineCreate,
    db: Session = Depends(get_db),
    user: User = Depends(manage_plans),
) -> FilmRequestLineOut:
    plan = db.get(WeeklyPlan, plan_id)
    if plan is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="План не найден")
    material, color, thickness = find_or_create_material_color_thickness(
        db, material=payload.material, color=payload.color, thickness=payload.thickness
    )
    line = FilmRequestLine(
        weekly_plan_id=plan_id,
        material_id=material.id,
        color_id=color.id,
        thickness_id=thickness.id,
        planned_area_m2=payload.planned_area_m2,
    )
    db.add(line)
    db.commit()
    db.refresh(line)
    return _line_out(db, line)


@router.get("/plan-fact", response_model=PlanFactOut)
def plan_fact(week_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> PlanFactOut:
    """План/факт расхода (2.8 ТЗ): план — из FilmRequestLine (м²), факт — из
    MaterialEvent (Выдача_участку/Списание) за период плана."""
    plan = db.get(WeeklyPlan, week_id)
    if plan is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="План не найден")

    lines: list[PlanFactLine] = []
    for line in plan.lines:
        actual = fetch_actual_for_group(
            db,
            material_id=line.material_id,
            color_id=line.color_id,
            thickness_id=line.thickness_id,
            date_from=plan.week_start,
            date_to=plan.week_end,
        )
        planned = float(line.planned_area_m2)
        lines.append(
            PlanFactLine(
                line_id=line.id,
                material=db.get(Material, line.material_id).name,
                color=db.get(Color, line.color_id).name,
                thickness=float(db.get(Thickness, line.thickness_id).value_mm),
                planned_area_m2=planned,
                actual_area_m2=actual.total_area_m2,
                percent_complete=round(actual.total_area_m2 / planned * 100, 1) if planned else 0,
                by_width=actual.by_width,
            )
        )

    return PlanFactOut(week_id=plan.id, week_start=plan.week_start, week_end=plan.week_end, lines=lines)
