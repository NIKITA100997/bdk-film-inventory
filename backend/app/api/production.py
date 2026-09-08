from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.core.constants import AREA_REQUIRES_ROLL_ON_REPORT
from app.core.security import get_current_user, get_permission_codes, require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import Color, Material, MaterialSku, Thickness
from app.models.units import MaterialUnit, UnitStatus
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.production import (
    ProductionLine,
    ProductionTask,
    ProductionTaskLine,
    ProductionTaskLineAssignment,
    ProductionTaskLineReport,
    ProductModel,
    ProductModelPart,
)
from app.models.users import User
from app.schemas.production import (
    BlankDemandLineOut,
    BlankPlanBlockOut,
    BlankPlanParsedLineOut,
    BlankPlanParseResultOut,
    NaryadParsedLineOut,
    NaryadParseResultOut,
    ProductionLineCreate,
    ProductionLineOut,
    ProductionLineUpdate,
    ProductionTaskLineAssignmentCreate,
    ProductionTaskLineAssignmentOut,
    ProductionTaskLineIssuedUnitOut,
    ProductionTaskLineSpecUpdate,
    ProductionTaskLineOut,
    ProductionTaskLineReportCreate,
    ProductionTaskLineReportOut,
    ProductionTaskManualCreate,
    ProductionTaskOut,
    ProductModelCreate,
    ProductModelOut,
    ProductModelPartCreate,
    ProductModelPartOut,
    ProductModelUpdate,
)
from app.schemas.deletion_requests import DeleteResultOut
from app.services.deletion_requests import request_deletion
from app.services.dictionaries import find_or_create_employees, find_or_create_material_color_thickness, task_lines_with_progress
from app.services.blank_plan_import import enrich_blank_plan_blocks, parse_blank_plan_xlsx_bytes
from app.services.naryad_import import enrich_naryad_lines, parse_naryad_xls_bytes
from app.services.plan_fact import fetch_issued_length_by_task_line
from app.services.part_units import advance_part_unit, write_off_part_unit
from app.services.production import (
    BlankDemandInputLine,
    BlankSupplyInputLine,
    aggregate_blank_demand,
    calc_default_strip_width,
    compute_remaining_length_m,
    compute_remaining_pieces,
    compute_shortfall_length_m,
    compute_unit_consumed_length_m,
)

router = APIRouter(tags=["production"])

# Пилот: окутка царговых (раздел про производственные задания) — модели
# продукции/BOM и сами задания заводит начальник цеха, та же по духу
# зона ответственности, что и orders.plan (строки потребности заказа).
manage_production = require_permission("production_tasks.manage")
# Отчёт о факте производства/браке (раздел про брак в производстве) —
# начальник участка (уже смотрит задания своего участка) или начальник
# цеха.
report_production = require_permission("production_tasks.manage", "production_tasks.report")
# Раздел про аудит прав — чтение заданий/линий/моделей раньше проверяло
# только валидный вход (get_current_user), без единого права: любой
# авторизованный (хоть продажник с sales_calculator.view) видел все задания
# всех участков напрямую через API, "видит только своё" было исключительно
# фильтром в браузере. production_tasks.view — единственное право без
# доступа к manage/report, поэтому для него дополнительно скопируем
# видимость до user.area прямо в запросе (см. _require_task_access ниже).
view_production = require_permission("production_tasks.manage", "production_tasks.report", "production_tasks.view")
# Модели продукции (BOM) — геометрия деталей без цвета/цены, ничего не
# раскрывает про реальные заказы/задания, поэтому продажнику (раздел про
# калькулятор заказа — расход плёнки на заказ по BOM модели) можно читать
# наравне с производством, в отличие от view_production выше.
view_product_models = require_permission(
    "production_tasks.manage", "production_tasks.report", "production_tasks.view", "sales_calculator.view"
)
# Список заданий отдельно ещё и от units.issue — склад читает те же задания
# на "Выдаче участку" (Issue.tsx), чтобы знать, что кроить/выдавать; складская
# роль по своей сути не привязана к одному участку производства (в отличие
# от production_tasks.report/.view), поэтому не сужается по user.area.
view_tasks = require_permission("production_tasks.manage", "production_tasks.report", "production_tasks.view", "units.issue")

def _can_see_all_areas(user: User) -> bool:
    if user.is_superuser:
        return True
    codes = get_permission_codes(user)
    return "production_tasks.manage" in codes or "units.issue" in codes


def _require_task_access(user: User, task: ProductionTask) -> None:
    if _can_see_all_areas(user) or task.area == user.area:
        return
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Задание не найдено")


def _line_out(line: ProductionLine) -> ProductionLineOut:
    return ProductionLineOut.model_validate(line)


def _part_out(db: Session, part: ProductModelPart) -> ProductModelPartOut:
    sw = (
        float(part.strip_width_mm)
        if part.strip_width_mm is not None
        else calc_default_strip_width(part.part_name, float(part.width_mm))
    )
    return ProductModelPartOut(
        id=part.id,
        area=part.area,
        qty_per_unit=float(part.qty_per_unit),
        width_mm=float(part.width_mm),
        length_m=float(part.length_m),
        strip_width_mm=sw,
        part_name=part.part_name,
    )


def _model_out(db: Session, model: ProductModel) -> ProductModelOut:
    return ProductModelOut(
        id=model.id,
        name=model.name,
        area=model.area,
        is_active=model.is_active,
        is_trim=model.is_trim,
        parts=[_part_out(db, p) for p in model.parts],
    )


def _task_line_out(
    db: Session,
    line: ProductionTaskLine,
    good: float,
    defect: float,
    assigned: float,
    assignment_report_aggs: dict[int, tuple[float, float]] | None = None,
    issued_length_m: float = 0.0,
    issued_units: list[MaterialUnit] | None = None,
) -> ProductionTaskLineOut:
    assignment_report_aggs = assignment_report_aggs or {}
    prod_line = db.get(ProductionLine, line.line_id) if line.line_id else None
    remaining_pieces = compute_remaining_pieces(float(line.quantity_pieces), good)
    shortfall_length_m = compute_shortfall_length_m(float(line.quantity_pieces), float(line.length_m), defect, issued_length_m)
    sw = (
        float(line.strip_width_mm)
        if line.strip_width_mm is not None
        else calc_default_strip_width(line.part_name, float(line.width_mm))
    )
    return ProductionTaskLineOut(
        id=line.id,
        line_id=line.line_id,
        line_name=prod_line.name if prod_line else "—",
        material=db.get(Material, line.material_id).name,
        color=db.get(Color, line.color_id).name,
        thickness=float(db.get(Thickness, line.thickness_id).value_mm),
        quantity_pieces=float(line.quantity_pieces),
        width_mm=float(line.width_mm),
        length_m=float(line.length_m),
        strip_width_mm=sw,
        part_name=line.part_name,
        produced_good_pieces=good,
        defect_pieces=defect,
        remaining_pieces=remaining_pieces,
        remaining_length_m=compute_remaining_length_m(float(line.length_m), remaining_pieces),
        shortfall_length_m=shortfall_length_m,
        assigned_pieces=assigned,
        unassigned_pieces=compute_remaining_pieces(float(line.quantity_pieces), assigned),
        assignments=[
            _assignment_out(db, a, *assignment_report_aggs.get(a.id, (0.0, 0.0, None))) for a in line.assignments
        ],
        planned_length_m=round(float(line.quantity_pieces) * float(line.length_m), 2),
        issued_length_m=issued_length_m,
        issued_units=[
            ProductionTaskLineIssuedUnitOut(
                id=u.id,
                width_mm=float(u.width_mm),
                length_m=float(u.length_m),
                material_sku_id=u.material_sku_id,
                parent_id=u.parent_id,
                is_strip=u.is_strip,
                status=u.status.value if hasattr(u.status, "value") else str(u.status),
                remaining_length_m=round(max(0.0, float(u.length_m) - _unit_consumed_length_m(db, u.id)), 2),
            )
            for u in (issued_units or [])
        ],
    )


def _line_report_aggregates(db: Session, line_ids: list[int]) -> dict[int, tuple[float, float]]:
    """Σ good_pieces/defect_pieces по строке задания (раздел про брак в
    производстве) — один запрос на все строки задания, не N+1."""
    if not line_ids:
        return {}
    rows = (
        db.query(
            ProductionTaskLineReport.task_line_id,
            func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
            func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0),
        )
        .filter(ProductionTaskLineReport.task_line_id.in_(line_ids))
        .group_by(ProductionTaskLineReport.task_line_id)
        .all()
    )
    return {row[0]: (float(row[1]), float(row[2])) for row in rows}


def _line_assignment_aggregates(db: Session, line_ids: list[int]) -> dict[int, float]:
    """Σ quantity_pieces по строке задания (раздел про распределение по
    линиям) — сколько уже расписано по линиям/дням, один запрос на все
    строки задания, не N+1."""
    if not line_ids:
        return {}
    rows = (
        db.query(
            ProductionTaskLineAssignment.task_line_id,
            func.coalesce(func.sum(ProductionTaskLineAssignment.quantity_pieces), 0),
        )
        .filter(ProductionTaskLineAssignment.task_line_id.in_(line_ids))
        .group_by(ProductionTaskLineAssignment.task_line_id)
        .all()
    )
    return {row[0]: float(row[1]) for row in rows}


def _assignment_report_aggregates(
    db: Session, assignment_ids: list[int]
) -> dict[int, tuple[float, float, int | None]]:
    """Σ good_pieces/defect_pieces по конкретной записи распределения
    (раздел про брак по дням) — тот же батч-приём, что
    _line_report_aggregates, только группировка по assignment_id, не
    task_line_id, чтобы видеть факт/брак за конкретный день/линию.
    material_unit_id — раздел про цифровой аналог "Ежедневки": все отчёты
    одной подачи формы ссылаются на один и тот же рулон, поэтому
    max(...) здесь просто выбирает единственное непустое значение, а не
    агрегирует по смыслу."""
    if not assignment_ids:
        return {}
    rows = (
        db.query(
            ProductionTaskLineReport.assignment_id,
            func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
            func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0),
            func.max(ProductionTaskLineReport.material_unit_id),
        )
        .filter(ProductionTaskLineReport.assignment_id.in_(assignment_ids))
        .group_by(ProductionTaskLineReport.assignment_id)
        .all()
    )
    return {row[0]: (float(row[1]), float(row[2]), row[3]) for row in rows}


def _unit_consumed_length_m(db: Session, unit_id: int) -> float:
    """Раздел про цифровой аналог "Ежедневки" — сколько метров этого
    рулона уже израсходовано, совокупно по всем отчётам, где бы и когда
    бы они ни были поданы (не только за один день/строку задания)."""
    rows = (
        db.query(
            ProductionTaskLineReport.good_pieces,
            ProductionTaskLineReport.defect_pieces,
            ProductionTaskLine.length_m,
        )
        .join(ProductionTaskLine, ProductionTaskLineReport.task_line_id == ProductionTaskLine.id)
        .filter(ProductionTaskLineReport.material_unit_id == unit_id)
        .all()
    )
    return compute_unit_consumed_length_m([(float(g), float(d), float(l)) for g, d, l in rows])


def _line_issued_units_map(db: Session, line_ids: list[int]) -> dict[int, list[MaterialUnit]]:
    """Единицы под каждую строку задания (раздел про единый процесс
    возврата) — один запрос на все строки, не N+1; группировка в Python,
    как в остальных агрегатах выше. Статус включает не только
    Выдан_участку, но и В_перемещении (раздел про разбор задания единой
    таблицей — кусок, автоматически ушедший в хаб на перемещение к
    домашнему складу участка, не теряет production_task_line_id,
    auto_transfer_if_wrong_warehouse его не трогает — раньше просто
    отфильтровывался отсюда статусом и был не виден на этом экране до
    самой приёмки). MaterialUnitOut/ProductionTaskLineIssuedUnitOut
    несёт статус — фронт отличает "выдано" от "едет через хаб" от
    "на складе Фабрики, ждёт довыдачи" (тот же кусок, статус вернулся к
    На_хранении после приёмки на другом складе, но привязка к строке
    осталась)."""
    if not line_ids:
        return {}
    units = (
        db.query(MaterialUnit)
        .filter(
            MaterialUnit.production_task_line_id.in_(line_ids),
            MaterialUnit.status.in_([UnitStatus.VYDAN_UCHASTKU, UnitStatus.V_PEREMESHCHENII, UnitStatus.NA_KHRANENII]),
        )
        .all()
    )
    result: dict[int, list[MaterialUnit]] = {}
    for u in units:
        result.setdefault(u.production_task_line_id, []).append(u)
    return result


def _task_out(db: Session, task: ProductionTask) -> ProductionTaskOut:
    model = db.get(ProductModel, task.product_model_id) if task.product_model_id else None
    line_ids = [l.id for l in task.lines]
    report_aggregates = _line_report_aggregates(db, line_ids)
    assignment_aggregates = _line_assignment_aggregates(db, line_ids)
    assignment_ids = [a.id for l in task.lines for a in l.assignments]
    assignment_report_aggs = _assignment_report_aggregates(db, assignment_ids)
    issued_length_by_line = fetch_issued_length_by_task_line(db, line_ids)
    issued_units_by_line = _line_issued_units_map(db, line_ids)
    line_outs = [
        _task_line_out(
            db,
            l,
            *report_aggregates.get(l.id, (0.0, 0.0)),
            assignment_aggregates.get(l.id, 0.0),
            assignment_report_aggs,
            issued_length_by_line.get(l.id, 0.0),
            issued_units_by_line.get(l.id, []),
        )
        for l in task.lines
    ]
    return ProductionTaskOut(
        id=task.id,
        product_model_id=task.product_model_id,
        product_model_name=model.name if model else None,
        name=task.name,
        area=task.area,
        quantity=task.quantity,
        external_order_ref=task.external_order_ref,
        created_by=task.created_by,
        created_at=task.created_at,
        is_active=task.is_active,
        lines=line_outs,
        planned_length_m=round(sum(l.planned_length_m for l in line_outs), 2),
        issued_length_m=round(sum(l.issued_length_m for l in line_outs), 2),
    )


# --- Линии -------------------------------------------------------------


@router.get("/production-lines", response_model=list[ProductionLineOut])
def list_production_lines(db: Session = Depends(get_db), user: User = Depends(view_production)) -> list[ProductionLine]:
    return db.query(ProductionLine).order_by(ProductionLine.name).all()


@router.post("/production-lines", response_model=ProductionLineOut, status_code=status.HTTP_201_CREATED)
def create_production_line(
    payload: ProductionLineCreate, db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> ProductionLine:
    if db.query(ProductionLine).filter(ProductionLine.name == payload.name).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Линия с таким названием уже есть")
    line = ProductionLine(name=payload.name, area=payload.area)
    db.add(line)
    db.commit()
    db.refresh(line)
    return line


@router.patch("/production-lines/{line_id}", response_model=ProductionLineOut)
def update_production_line(
    line_id: int, payload: ProductionLineUpdate, db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> ProductionLine:
    line = db.get(ProductionLine, line_id)
    if line is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Линия не найдена")
    if payload.name is not None and payload.name != line.name:
        if db.query(ProductionLine).filter(ProductionLine.name == payload.name, ProductionLine.id != line_id).first():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Линия с таким названием уже есть")
        line.name = payload.name
    if payload.area is not None:
        line.area = payload.area
    if payload.is_active is not None:
        line.is_active = payload.is_active
    db.commit()
    db.refresh(line)
    return line


# --- Модели продукции ---------------------------------------------------


@router.get("/product-models", response_model=list[ProductModelOut])
def list_product_models(db: Session = Depends(get_db), user: User = Depends(view_product_models)) -> list[ProductModelOut]:
    models = db.query(ProductModel).options(joinedload(ProductModel.parts)).order_by(ProductModel.name).all()
    return [_model_out(db, m) for m in models]


@router.get("/product-models/{model_id}", response_model=ProductModelOut)
def get_product_model(model_id: int, db: Session = Depends(get_db), user: User = Depends(view_product_models)) -> ProductModelOut:
    model = db.get(ProductModel, model_id)
    if model is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Модель не найдена")
    return _model_out(db, model)


@router.post("/product-models", response_model=ProductModelOut, status_code=status.HTTP_201_CREATED)
def create_product_model(
    payload: ProductModelCreate, db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> ProductModelOut:
    if db.query(ProductModel).filter(ProductModel.name == payload.name).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Модель с таким названием уже есть")
    model = ProductModel(name=payload.name, area=payload.area, is_trim=payload.is_trim)
    db.add(model)
    db.commit()
    db.refresh(model)
    return _model_out(db, model)


@router.patch("/product-models/{model_id}", response_model=ProductModelOut)
def update_product_model(
    model_id: int, payload: ProductModelUpdate, db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> ProductModelOut:
    model = db.get(ProductModel, model_id)
    if model is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Модель не найдена")
    if payload.name is not None and payload.name != model.name:
        if db.query(ProductModel).filter(ProductModel.name == payload.name, ProductModel.id != model_id).first():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Модель с таким названием уже есть")
        model.name = payload.name
    if payload.is_active is not None:
        model.is_active = payload.is_active
    if payload.is_trim is not None:
        model.is_trim = payload.is_trim
    db.commit()
    db.refresh(model)
    return _model_out(db, model)


@router.post("/product-models/{model_id}/parts", response_model=ProductModelPartOut, status_code=status.HTTP_201_CREATED)
def add_product_model_part(
    model_id: int, payload: ProductModelPartCreate, db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> ProductModelPartOut:
    model = db.get(ProductModel, model_id)
    if model is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Модель не найдена")
    sw = payload.strip_width_mm if payload.strip_width_mm is not None else calc_default_strip_width(payload.part_name, payload.width_mm)
    part = ProductModelPart(
        product_model_id=model_id,
        area=payload.area,
        qty_per_unit=payload.qty_per_unit,
        width_mm=payload.width_mm,
        length_m=payload.length_m,
        strip_width_mm=sw,
        part_name=payload.part_name,
    )
    db.add(part)
    db.commit()
    db.refresh(part)
    return _part_out(db, part)


@router.put("/product-models/{model_id}/parts/{part_id}", response_model=ProductModelPartOut)
def update_product_model_part(
    model_id: int, part_id: int, payload: ProductModelPartCreate, db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> ProductModelPartOut:
    part = db.query(ProductModelPart).filter(ProductModelPart.id == part_id, ProductModelPart.product_model_id == model_id).first()
    if part is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Деталь не найдена")
    sw = payload.strip_width_mm if payload.strip_width_mm is not None else calc_default_strip_width(payload.part_name, payload.width_mm)
    part.area = payload.area
    part.qty_per_unit = payload.qty_per_unit
    part.width_mm = payload.width_mm
    part.length_m = payload.length_m
    part.strip_width_mm = sw
    part.part_name = payload.part_name
    db.commit()
    db.refresh(part)
    return _part_out(db, part)


@router.delete("/product-models/{model_id}/parts/{part_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product_model_part(
    model_id: int, part_id: int, db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> None:
    part = db.query(ProductModelPart).filter(ProductModelPart.id == part_id, ProductModelPart.product_model_id == model_id).first()
    if part is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Деталь не найдена")
    db.delete(part)
    db.commit()


# --- Производственные задания -------------------------------------------


@router.get("/production-tasks", response_model=list[ProductionTaskOut])
def list_production_tasks(db: Session = Depends(get_db), user: User = Depends(view_tasks)) -> list[ProductionTaskOut]:
    query = db.query(ProductionTask).options(joinedload(ProductionTask.lines))
    if not _can_see_all_areas(user):
        query = query.filter(ProductionTask.area == user.area)
    tasks = query.order_by(ProductionTask.created_at.desc()).all()
    return [_task_out(db, t) for t in tasks]


@router.get("/blanks-demand", response_model=list[BlankDemandLineOut])
def get_blanks_demand(
    db: Session = Depends(get_db), user: User = Depends(require_permission("units.issue"))
) -> list[BlankDemandLineOut]:
    """Раздел про «Заготовки» — сколько ещё нужно нарезать про запас, пока
    задания не расписаны по дням/линиям и за плёнкой ещё не пришли: считает
    потребность по ВСЕМ активным заданиям целиком (не только уже
    распределённым, как очередь «Выдача участку»), в сравнении с тем, что
    уже нарезано и лежит на складе никому не назначенным."""
    lines = (
        db.query(ProductionTaskLine)
        .join(ProductionTask, ProductionTaskLine.task_id == ProductionTask.id)
        .filter(ProductionTask.is_active.is_(True))
        .all()
    )
    line_ids = [l.id for l in lines]
    report_aggregates = _line_report_aggregates(db, line_ids)
    issued_length_by_line = fetch_issued_length_by_task_line(db, line_ids)

    demand_lines = []
    for line in lines:
        good, defect = report_aggregates.get(line.id, (0.0, 0.0))
        issued = issued_length_by_line.get(line.id, 0.0)
        shortfall = compute_shortfall_length_m(float(line.quantity_pieces), float(line.length_m), defect, issued)
        if shortfall <= 0:
            continue
        sw = (
            float(line.strip_width_mm)
            if line.strip_width_mm is not None
            else calc_default_strip_width(line.part_name, float(line.width_mm))
        )
        demand_lines.append(BlankDemandInputLine(line.material_id, line.color_id, line.thickness_id, sw, shortfall))

    supply_rows = (
        db.query(MaterialSku.material_id, MaterialSku.color_id, MaterialSku.thickness_id, MaterialUnit.width_mm, MaterialUnit.length_m)
        .join(MaterialSku, MaterialUnit.material_sku_id == MaterialSku.id)
        .filter(MaterialUnit.status == UnitStatus.NA_KHRANENII, MaterialUnit.production_task_line_id.is_(None))
        .all()
    )
    supply_lines = [
        BlankSupplyInputLine(material_id, color_id, thickness_id, float(width_mm), float(length_m))
        for material_id, color_id, thickness_id, width_mm, length_m in supply_rows
    ]

    rows = aggregate_blank_demand(demand_lines, supply_lines)
    if not rows:
        return []

    material_ids = {r.material_id for r in rows}
    color_ids = {r.color_id for r in rows}
    thickness_ids = {r.thickness_id for r in rows}
    materials = {m.id: m.name for m in db.query(Material).filter(Material.id.in_(material_ids)).all()}
    colors = {c.id: c.name for c in db.query(Color).filter(Color.id.in_(color_ids)).all()}
    thicknesses = {t.id: float(t.value_mm) for t in db.query(Thickness).filter(Thickness.id.in_(thickness_ids)).all()}

    return [
        BlankDemandLineOut(
            material=materials[r.material_id],
            color=colors[r.color_id],
            thickness=thicknesses[r.thickness_id],
            width_mm=r.width_mm,
            needed_length_m=r.needed_length_m,
            on_hand_length_m=r.on_hand_length_m,
            deficit_length_m=r.deficit_length_m,
        )
        for r in rows
    ]


@router.post("/production-tasks/manual", response_model=ProductionTaskOut, status_code=status.HTTP_201_CREATED)
def create_production_task_manual(
    payload: ProductionTaskManualCreate, db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> ProductionTaskOut:
    task = ProductionTask(
        product_model_id=payload.product_model_id,
        quantity=payload.quantity,
        name=payload.name,
        external_order_ref=payload.external_order_ref,
        area=payload.area,
        created_by=user.id,
    )
    db.add(task)
    db.flush()
    for line_payload in payload.lines:
        if line_payload.line_id is not None:
            line = db.get(ProductionLine, line_payload.line_id)
            if line is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Линия не найдена")
            if line.area != payload.area:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Линия принадлежит другому участку, чем задание"
                )
        material, color, thickness = find_or_create_material_color_thickness(
            db, material=line_payload.material, color=line_payload.color, thickness=line_payload.thickness
        )
        sw = (
            line_payload.strip_width_mm
            if line_payload.strip_width_mm is not None
            else calc_default_strip_width(line_payload.part_name, line_payload.width_mm)
        )
        db.add(
            ProductionTaskLine(
                task_id=task.id,
                line_id=line_payload.line_id,
                material_id=material.id,
                color_id=color.id,
                thickness_id=thickness.id,
                quantity_pieces=line_payload.quantity_pieces,
                width_mm=line_payload.width_mm,
                length_m=line_payload.length_m,
                strip_width_mm=sw,
                part_name=line_payload.part_name,
            )
        )
    db.commit()
    db.refresh(task)
    return _task_out(db, task)


@router.post("/production-tasks/parse-naryad", response_model=NaryadParseResultOut)
async def parse_naryad(
    file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> NaryadParseResultOut:
    """Раздел про загрузку наряд-заказа — разбирает печатную форму
    («Перечень деталей столярных изделий», раздел «РАСКЛАДКА») в строки
    задания. Только предпросмотр: ничего не создаёт и не пишет в БД —
    материал/цвет/толщину плёнки и участок пользователь выбирает на
    фронтенде (файл их не содержит), после чего строки уходят в тот же
    POST /production-tasks/manual, что и при ручном/BOM-создании.
    enrich_naryad_lines — соответствие деталям и точная ширина штрипса
    из справочника вместо грубой формулы, тот же принцип, что уже есть у
    плана заготовок (parse_blank_plan ниже)."""
    data = await file.read()
    try:
        result = parse_naryad_xls_bytes(data)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Не удалось прочитать файл — убедитесь, что это .xls (Excel 97-2003) и он не повреждён",
        )
    if not result.lines:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="В файле не найдено ни одной строки с деталями")
    result = enrich_naryad_lines(db, result)
    return NaryadParseResultOut(
        suggested_name=result.suggested_name,
        lines=[NaryadParsedLineOut(**l.__dict__) for l in result.lines],
        order_number=result.order_number,
    )


@router.post("/production-tasks/parse-blank-plan", response_model=BlankPlanParseResultOut)
async def parse_blank_plan(
    file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> BlankPlanParseResultOut:
    """Раздел про импорт плана заготовок (Excel) — лист планирования
    окутки/раскроя на дату («Номенклатура/Цвет/.../Заказ»), в отличие от
    наряд-заказа даёт цвет отдельно у каждой строки, поэтому материал
    подбирается построчно уже здесь (services.blank_plan_import.enrich_blank_plan_blocks),
    не общим полем на фронтенде. Один файл может содержать несколько
    листов и несколько блоков на лист (бок о бок) — каждый блок отдаётся
    отдельно, задание создаётся на каждый по отдельности (тот же
    POST /production-tasks/manual, что и у остальных способов) — только
    предпросмотр, в БД ничего не пишет."""
    data = await file.read()
    try:
        blocks = parse_blank_plan_xlsx_bytes(data)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Не удалось прочитать файл — убедитесь, что это .xlsx и он не повреждён"
        )
    if not blocks:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Не найдено ни одного блока со строками для производства (везде «Заказ» = 0 или пусто)",
        )
    enriched = enrich_blank_plan_blocks(db, blocks)
    return BlankPlanParseResultOut(
        blocks=[
            BlankPlanBlockOut(
                sheet_name=b.sheet_name,
                suggested_name=b.suggested_name,
                lines=[BlankPlanParsedLineOut(**l.__dict__) for l in b.lines],
            )
            for b in enriched
        ]
    )


# --- Брак в производстве -------------------------------------------------


def _get_task_line(db: Session, task_id: int, line_id: int) -> ProductionTaskLine:
    line = (
        db.query(ProductionTaskLine)
        .filter(ProductionTaskLine.id == line_id, ProductionTaskLine.task_id == task_id)
        .first()
    )
    if line is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Строка задания не найдена")
    return line


@router.get("/production-tasks/{task_id}/lines/{line_id}/reports", response_model=list[ProductionTaskLineReportOut])
def list_task_line_reports(
    task_id: int, line_id: int, db: Session = Depends(get_db), user: User = Depends(view_production)
) -> list[ProductionTaskLineReport]:
    line = _get_task_line(db, task_id, line_id)
    _require_task_access(user, line.task)
    return (
        db.query(ProductionTaskLineReport)
        .filter(ProductionTaskLineReport.task_line_id == line_id)
        .order_by(ProductionTaskLineReport.reported_at.desc())
        .all()
    )


@router.post(
    "/production-tasks/{task_id}/lines/{line_id}/reports",
    response_model=ProductionTaskLineReportOut,
    status_code=status.HTTP_201_CREATED,
)
def create_task_line_report(
    task_id: int,
    line_id: int,
    payload: ProductionTaskLineReportCreate,
    db: Session = Depends(get_db),
    user: User = Depends(report_production),
) -> ProductionTaskLineReport:
    """Отчёт о факте производства (раздел про брак в производстве) — не
    мутирует ProductionTaskLine.quantity_pieces (неизменная цель),
    накопительный журнал, остаток считается на лету при сборке
    ProductionTaskOut (см. _line_report_aggregates) — так остаток
    "видит" сумму по нескольким отчётам (например, за разные смены).
    Обычно привязан к конкретной записи распределения (раздел про брак по
    дням) — мастер отчитывается за конкретный день/линию, не за строку
    задания в целом. Исключение — участок с Area.requires_daily_plan=False
    (раздел про отключение распределения по дням): там распределений и не
    предполагается, отчёт принимается без assignment_id."""
    line = _get_task_line(db, task_id, line_id)
    area = db.get(Area, line.task.area)
    requires_daily_plan = area is None or area.requires_daily_plan
    if payload.assignment_id is not None:
        assignment = db.get(ProductionTaskLineAssignment, payload.assignment_id)
        if assignment is None or assignment.task_line_id != line_id:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Распределение не найдено для этой строки задания")
    elif requires_daily_plan:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Для этого участка отчёт должен быть привязан к распределению по дням")
    if payload.material_unit_id is not None:
        unit = db.get(MaterialUnit, payload.material_unit_id)
        # Раздел про сверку рулонов на окутке — допускаем ещё и На_хранении
        # (не только Выдан_участку): пилот "Ежедневки" запущен позже, чем
        # часть рулонов успели вернуть, поэтому отчёт по ним заводится
        # задним числом уже после физического возврата (см. панель
        # "Сверка рулонов"). Раньше это падало 422 "рулон не найден среди
        # выданных" — рулон-то физически давно на складе, отчёт всё равно
        # нужно занести.
        if unit is None or unit.production_task_line_id != line_id or unit.status not in (
            UnitStatus.VYDAN_UCHASTKU, UnitStatus.NA_KHRANENII,
        ):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Рулон не найден среди выданных на эту строку")
    elif line.task.area == AREA_REQUIRES_ROLL_ON_REPORT:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Для этого участка отчёт должен быть привязан к рулону")
    # Раздел про физический учёт деталей (пилот: окутка царговых) —
    # необязательно (в отличие от рулона выше): не у каждой детали ещё
    # настроены этапы, участок продолжает работать без партии, пока цех не
    # донастроит справочник. Раздел про связь этапов с участками — партия
    # переезжает между РАЗНЫМИ заданиями по мере продвижения по этапам (у
    # каждого участка своё), её production_task_line_id так и остаётся
    # указывать на задание, где она родилась; годной для отчёта партия
    # считается по физическому месту — она должна быть выдана ИМЕННО этому
    # участку (тому же, что и у строки задания), не обязательно этой строке.
    part_unit = None
    if payload.part_unit_id is not None:
        part_unit = db.get(PartUnit, payload.part_unit_id)
        if (
            part_unit is None
            or part_unit.area != line.task.area
            or part_unit.status != PartUnitStatus.VYDAN_UCHASTKU
        ):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Партия п/ф не найдена среди выданных этому участку")
        if payload.defect_pieces > 0 and not payload.defect_reason:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Укажите причину брака, чтобы списать партию п/ф")
    report = ProductionTaskLineReport(
        task_line_id=line_id,
        assignment_id=payload.assignment_id,
        material_unit_id=payload.material_unit_id,
        part_unit_id=payload.part_unit_id,
        good_pieces=payload.good_pieces,
        defect_pieces=payload.defect_pieces,
        defect_reason=payload.defect_reason,
        note=payload.note,
        reported_by=user.id,
    )
    db.add(report)
    if part_unit is not None:
        try:
            if payload.good_pieces > 0:
                advance_part_unit(db, unit=part_unit, quantity_pieces=payload.good_pieces, user_id=user.id)
            if payload.defect_pieces > 0:
                write_off_part_unit(
                    db,
                    unit=part_unit,
                    quantity_pieces=payload.defect_pieces,
                    reason=payload.defect_reason,
                    user_id=user.id,
                    note=payload.note,
                )
        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)) from e
    db.commit()
    db.refresh(report)
    return report


# --- Распределение по линиям ---------------------------------------------


def _assignment_out(
    db: Session,
    a: ProductionTaskLineAssignment,
    produced_good_pieces: float = 0.0,
    defect_pieces: float = 0.0,
    material_unit_id: int | None = None,
) -> ProductionTaskLineAssignmentOut:
    line = db.get(ProductionLine, a.line_id)
    issued_length_m = None
    remaining_length_m = None
    if material_unit_id is not None:
        unit = db.get(MaterialUnit, material_unit_id)
        if unit is not None:
            issued_length_m = float(unit.length_m)
            remaining_length_m = round(
                max(0.0, issued_length_m - _unit_consumed_length_m(db, unit.id)), 2
            )
    return ProductionTaskLineAssignmentOut(
        id=a.id,
        line_id=a.line_id,
        line_name=line.name if line else "—",
        date=a.date,
        employee_names=a.employee_names,
        quantity_pieces=float(a.quantity_pieces),
        created_by=a.created_by,
        created_at=a.created_at,
        produced_good_pieces=produced_good_pieces,
        defect_pieces=defect_pieces,
        material_unit_id=material_unit_id,
        issued_length_m=issued_length_m,
        remaining_length_m=remaining_length_m,
    )


@router.get(
    "/production-tasks/{task_id}/lines/{line_id}/assignments", response_model=list[ProductionTaskLineAssignmentOut]
)
def list_task_line_assignments(
    task_id: int, line_id: int, db: Session = Depends(get_db), user: User = Depends(view_production)
) -> list[ProductionTaskLineAssignmentOut]:
    line = _get_task_line(db, task_id, line_id)
    _require_task_access(user, line.task)
    assignments = (
        db.query(ProductionTaskLineAssignment)
        .filter(ProductionTaskLineAssignment.task_line_id == line_id)
        .order_by(ProductionTaskLineAssignment.date.desc(), ProductionTaskLineAssignment.created_at.desc())
        .all()
    )
    report_aggs = _assignment_report_aggregates(db, [a.id for a in assignments])
    return [_assignment_out(db, a, *report_aggs.get(a.id, (0.0, 0.0, None))) for a in assignments]


@router.post(
    "/production-tasks/{task_id}/lines/{line_id}/assignments",
    response_model=ProductionTaskLineAssignmentOut,
    status_code=status.HTTP_201_CREATED,
)
def create_task_line_assignment(
    task_id: int,
    line_id: int,
    payload: ProductionTaskLineAssignmentCreate,
    db: Session = Depends(get_db),
    user: User = Depends(report_production),
) -> ProductionTaskLineAssignmentOut:
    """Раздел про распределение по линиям — начальник участка расписывает
    строку задания по линиям/дням/сотрудникам отдельным шагом после того,
    как задание уже поставлено на участок (не мутирует саму строку задания,
    накопительный журнал — тот же приём, что ProductionTaskLineReport)."""
    task_line = _get_task_line(db, task_id, line_id)
    line = db.get(ProductionLine, payload.line_id)
    if line is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Линия не найдена")
    task = db.get(ProductionTask, task_line.task_id)
    if line.area != task.area:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Линия принадлежит другому участку, чем задание"
        )
    assigned_so_far = float(
        db.query(func.coalesce(func.sum(ProductionTaskLineAssignment.quantity_pieces), 0))
        .filter(ProductionTaskLineAssignment.task_line_id == line_id)
        .scalar()
    )
    if assigned_so_far + payload.quantity_pieces > float(task_line.quantity_pieces):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Распределено уже {assigned_so_far:g} из {float(task_line.quantity_pieces):g} шт. — "
                f"нельзя добавить ещё {payload.quantity_pieces:g}"
            ),
        )
    find_or_create_employees(db, payload.employee_names.split(","))
    assignment = ProductionTaskLineAssignment(
        task_line_id=line_id,
        line_id=payload.line_id,
        date=payload.date,
        employee_names=payload.employee_names,
        quantity_pieces=payload.quantity_pieces,
        created_by=user.id,
    )
    db.add(assignment)
    db.commit()
    db.refresh(assignment)
    return _assignment_out(db, assignment)


@router.get("/production-tasks/{task_id}", response_model=ProductionTaskOut)
def get_production_task(task_id: int, db: Session = Depends(get_db), user: User = Depends(view_tasks)) -> ProductionTaskOut:
    task = db.get(ProductionTask, task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Задание не найдено")
    _require_task_access(user, task)
    return _task_out(db, task)


@router.patch("/production-tasks/{task_id}/lines/{line_id}", response_model=ProductionTaskOut)
def update_task_line_spec(
    task_id: int,
    line_id: int,
    payload: ProductionTaskLineSpecUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(manage_production),
) -> ProductionTaskOut:
    """Правка размера/штрипса/материала уже в созданном задании (пока
    размеры ещё тестируются и не всегда хватает нужной номенклатуры) —
    раньше единственный способ поправить их был через справочник деталей
    (sync_part_to_task_lines) или через "исправление" прямо на резке
    (override_strip_width/override_material в units.py); здесь то же
    самое, но явно, из самого задания, без похода в другой экран."""
    line = db.get(ProductionTaskLine, line_id)
    if line is None or line.task_id != task_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Строка задания не найдена")
    if line.id in task_lines_with_progress(db, [line.id]):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="По этой строке уже была резка, отчёт о выпуске или распределение по линии — менять размер/материал задним числом небезопасно",
        )
    if payload.width_mm is not None:
        line.width_mm = payload.width_mm
    if payload.length_m is not None:
        line.length_m = payload.length_m
    if "strip_width_mm" in payload.model_fields_set:
        line.strip_width_mm = payload.strip_width_mm
    if payload.sku_id is not None:
        sku = db.get(MaterialSku, payload.sku_id)
        if sku is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Позиция номенклатуры не найдена")
        line.material_id = sku.material_id
        line.color_id = sku.color_id
        line.thickness_id = sku.thickness_id
    db.commit()
    task = db.get(ProductionTask, task_id)
    return _task_out(db, task)


def delete_production_task_impl(db: Session, task: ProductionTask) -> None:
    """Раздел про удаление сущностей — общая guarded-логика, вызывается и
    прямым DELETE суперпользователя, и одобрением заявки на удаление
    (api/deletion_requests.py). Единицы, реально выданные по строкам
    этого задания, — если по заданию уже была движуха, его не удаляют, а
    оставляют как есть (задание либо ещё пустое, либо часть истории
    склада — архивировать такое тоже можно, см. is_active)."""
    line_ids = [l.id for l in task.lines]
    has_units = (
        bool(line_ids) and db.query(MaterialUnit.id).filter(MaterialUnit.production_task_line_id.in_(line_ids)).first() is not None
    )
    if has_units:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Нельзя удалить задание — по нему уже выдавалась плёнка. Такое задание остаётся в истории склада.",
        )
    db.delete(task)


@router.delete("/production-tasks/{task_id}", response_model=DeleteResultOut)
def delete_production_task(
    task_id: int, db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> DeleteResultOut:
    task = db.get(ProductionTask, task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Задание не найдено")
    if not user.is_superuser:
        label = f"Задание №{task.id} — {task.name or (db.get(ProductModel, task.product_model_id).name if task.product_model_id else 'без названия')}"
        request_deletion(db, entity_type="production_task", entity_id=task.id, entity_label=label, requested_by=user.id)
        db.commit()
        return DeleteResultOut(deleted=False, requested=True)
    delete_production_task_impl(db, task)
    db.commit()
    return DeleteResultOut(deleted=True, requested=False)


@router.patch("/production-tasks/{task_id}/archive", response_model=ProductionTaskOut)
def archive_production_task(
    task_id: int, is_active: bool, db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> ProductionTaskOut:
    task = db.get(ProductionTask, task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Задание не найдено")
    task.is_active = is_active
    db.commit()
    db.refresh(task)
    return _task_out(db, task)


@router.delete("/product-models/{model_id}")
def delete_product_model(
    model_id: int, db: Session = Depends(get_db), user: User = Depends(manage_production)
):
    model = db.get(ProductModel, model_id)
    if model is not None:
        db.delete(model)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
