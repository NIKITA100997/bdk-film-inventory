from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_roles
from app.db.session import get_db
from app.models.abc import CalcSettings, WidthAbcClass, WidthClass
from app.models.dictionaries import Color, Material, Thickness
from app.models.users import User
from app.schemas.abc import CalcSettingsOut, CalcSettingsUpdate, RecomputeResult, WidthAbcClassOut
from app.services.abc_analysis import recompute_abc_classes

router = APIRouter(tags=["abc"])

manage_calc_settings = require_roles("logist", "admin")


def _get_settings(db: Session) -> CalcSettings:
    settings = db.get(CalcSettings, 1)
    if settings is None:
        settings = CalcSettings(id=1)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


@router.get("/calc-settings", response_model=CalcSettingsOut)
def get_calc_settings(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> CalcSettings:
    return _get_settings(db)


@router.patch("/calc-settings", response_model=CalcSettingsOut)
def update_calc_settings(
    payload: CalcSettingsUpdate, db: Session = Depends(get_db), user: User = Depends(manage_calc_settings)
) -> CalcSettings:
    settings = _get_settings(db)
    settings.min_useful_width_mm = payload.min_useful_width_mm
    settings.abc_recalc_period_days = payload.abc_recalc_period_days
    settings.cells_per_strip_shelf = payload.cells_per_strip_shelf
    settings.stale_threshold_days = payload.stale_threshold_days
    settings.shortage_note_template = payload.shortage_note_template
    db.commit()
    db.refresh(settings)
    return settings


@router.post("/abc/recompute", response_model=RecomputeResult)
def recompute(
    period_days: int | None = Query(default=None, gt=0),
    db: Session = Depends(get_db),
    user: User = Depends(manage_calc_settings),
) -> RecomputeResult:
    """Пересчёт ABC-классов (2.9 ТЗ) — ручной запуск; период по умолчанию
    берётся из настроек расчётов. Автоматический ежемесячный пересчёт
    (планировщик) — вне объёма этого этапа, см. открытые вопросы плана."""
    period = period_days or _get_settings(db).abc_recalc_period_days
    updated = recompute_abc_classes(db, period_days=period)
    return RecomputeResult(updated=updated, period_days=period)


@router.get("/abc/classes", response_model=list[WidthAbcClassOut])
def list_classes(
    width_class: WidthClass | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WidthAbcClassOut]:
    """Список классов (5.4 "Рекомендации по резке" ТЗ — по умолчанию класс C,
    но фильтр не обязателен). Прямых relationship на справочники в модели
    нет — имена подтягиваются точечно через маленький кэш ниже, отдельная
    связь ради трёх текстовых полей была бы избыточной."""
    rows = db.query(WidthAbcClass)
    if width_class is not None:
        rows = rows.filter(WidthAbcClass.width_class == width_class)
    rows = rows.order_by(WidthAbcClass.width_class, WidthAbcClass.total_length_m.desc()).all()

    material_cache: dict[int, str] = {}
    color_cache: dict[int, str] = {}
    thickness_cache: dict[int, float] = {}

    def _material(id_: int) -> str:
        if id_ not in material_cache:
            material_cache[id_] = db.get(Material, id_).name
        return material_cache[id_]

    def _color(id_: int) -> str:
        if id_ not in color_cache:
            color_cache[id_] = db.get(Color, id_).name
        return color_cache[id_]

    def _thickness(id_: int) -> float:
        if id_ not in thickness_cache:
            thickness_cache[id_] = float(db.get(Thickness, id_).value_mm)
        return thickness_cache[id_]

    return [
        WidthAbcClassOut(
            id=r.id,
            material=_material(r.material_id),
            color=_color(r.color_id),
            thickness=_thickness(r.thickness_id),
            width_mm=float(r.width_mm),
            width_class=r.width_class,
            total_length_m=float(r.total_length_m),
            computed_at=r.computed_at,
        )
        for r in rows
    ]
