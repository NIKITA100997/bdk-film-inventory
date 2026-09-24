from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session, joinedload

from app.core.constants import AREA_REQUIRES_ROLL_ON_REPORT, PART_UNIT_AUTO_WRITE_OFF_REASON_CODE
from app.core.security import get_current_user, get_permission_codes, require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import Color, Material, MaterialSku, Part, PartStage, Thickness
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
    AreaOperationOut,
    OperationTaskCreate,
    BlankDemandLineOut,
    BlankPlanBlockOut,
    BlankPlanParsedLineOut,
    BlankPlanParseResultOut,
    BorrowableUnitOut,
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
from app.services.components import sync_bom_components
from app.services.area_tasks import apply_report_to_part_units, validate_line_stage
from app.services.deletion_requests import request_deletion
from app.services.dictionaries import find_or_create_employees, find_or_create_material_color_thickness, task_lines_with_progress
from app.services.blank_plan_import import enrich_blank_plan_blocks, parse_blank_plan_xlsx_bytes
from app.services.naryad_import import enrich_naryad_lines, parse_naryad_xls_bytes
from app.services.plan_fact import fetch_issued_length_by_task_line
from app.services.part_units import (
    advance_part_unit,
    consume_defect_fifo,
    consume_part_units_fifo,
    reserve_defect_for_recycle_fifo,
    settle_excess_part_unit_at_area,
    write_off_part_unit,
)
from app.services.production import (
    BlankDemandInputLine,
    BlankSupplyInputLine,
    GroupShortfallLine,
    aggregate_blank_demand,
    calc_default_strip_width,
    compute_remaining_length_m,
    compute_remaining_pieces,
    compute_shortfall_length_m,
    compute_unit_consumed_length_m,
    distribute_group_shortfall,
)
from app.services.width_analogs import equivalent_widths

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


def _issued_unit_remaining_m(db: Session, u: MaterialUnit) -> float:
    return round(max(0.0, float(u.length_m) - _unit_consumed_length_m(db, u.id)), 2)


def _line_effective_strip_width(line: ProductionTaskLine) -> float:
    return (
        float(line.strip_width_mm)
        if line.strip_width_mm is not None
        else calc_default_strip_width(line.part_name, float(line.width_mm))
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
    shortfall_length_m: float | None = None,
    borrowable_units: list[tuple[MaterialUnit, ProductionTaskLine]] | None = None,
) -> ProductionTaskLineOut:
    assignment_report_aggs = assignment_report_aggs or {}
    prod_line = db.get(ProductionLine, line.line_id) if line.line_id else None
    remaining_pieces = compute_remaining_pieces(float(line.quantity_pieces), good)
    # shortfall считается по группе ширины на уровне задания (_task_out) —
    # раздел про общий штрипс на детали одного задания; сюда приходит
    # готовым. Fallback на построчный расчёт — на случай прямого вызова.
    if shortfall_length_m is None:
        shortfall_length_m = compute_shortfall_length_m(
            float(line.quantity_pieces), float(line.length_m), defect, issued_length_m
        )
    sw = _line_effective_strip_width(line)
    return ProductionTaskLineOut(
        id=line.id,
        line_id=line.line_id,
        line_name=prod_line.name if prod_line else "—",
        material=db.get(Material, line.material_id).name if line.material_id else None,
        color=db.get(Color, line.color_id).name if line.color_id else None,
        thickness=float(db.get(Thickness, line.thickness_id).value_mm) if line.thickness_id else None,
        quantity_pieces=float(line.quantity_pieces),
        width_mm=float(line.width_mm),
        length_m=float(line.length_m),
        strip_width_mm=sw,
        part_name=line.part_name,
        operation_name=db.get(PartStage, line.part_stage_id).name if line.part_stage_id else None,
        is_closed=line.is_closed,
        production_closed=line.production_closed,
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
                remaining_length_m=_issued_unit_remaining_m(db, u),
                area=u.area,
            )
            for u in (issued_units or [])
        ],
        borrowable_units=[
            BorrowableUnitOut(
                id=u.id,
                width_mm=float(u.width_mm),
                length_m=float(u.length_m),
                material_sku_id=u.material_sku_id,
                parent_id=u.parent_id,
                is_strip=u.is_strip,
                status=u.status.value if hasattr(u.status, "value") else str(u.status),
                remaining_length_m=_issued_unit_remaining_m(db, u),
                area=u.area,
                from_line_id=src_line.id,
                from_part_name=src_line.part_name,
            )
            for u, src_line in (borrowable_units or [])
        ],
    )


def _line_report_aggregates(db: Session, line_ids: list[int]) -> dict[int, tuple[float, float]]:
    """Σ good_pieces/defect_pieces по строке задания (раздел про брак в
    производстве) — один запрос на все строки задания, не N+1.

    Раздел про окутку в 2 захода — фильтр по counts_toward_line=True:
    промежуточный переход партии п/ф (деталь физически ещё не готова,
    см. create_task_line_report/advance_part_unit) не должен уменьшать
    "нужно ещё" по заданию участка, хотя расход рулона по нему уже
    учтён (compute_unit_consumed_length_m таких фильтров не знает —
    расход плёнки фиксируется независимо от готовности детали)."""
    if not line_ids:
        return {}
    rows = (
        db.query(
            ProductionTaskLineReport.task_line_id,
            func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
            func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0),
        )
        .filter(
            ProductionTaskLineReport.task_line_id.in_(line_ids),
            ProductionTaskLineReport.counts_toward_line.is_(True),
        )
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
    агрегирует по смыслу.

    counts_toward_line=True — тот же фильтр, что и в
    _line_report_aggregates (раздел про окутку в 2 захода): сегодня
    assignment_id и part_unit_id на практике не пересекаются (участки с
    распределением по дням и участки с этапами п/ф — разные), но фильтр
    здесь на будущее, чтобы промежуточный переход не задваивал факт и
    для дневного распределения тоже."""
    if not assignment_ids:
        return {}
    rows = (
        db.query(
            ProductionTaskLineReport.assignment_id,
            func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
            func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0),
            func.max(ProductionTaskLineReport.material_unit_id),
        )
        .filter(
            ProductionTaskLineReport.assignment_id.in_(assignment_ids),
            ProductionTaskLineReport.counts_toward_line.is_(True),
        )
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
            # Раздел про цепочку выдан→на_хранении — На_хранении сюда
            # попадает ТОЛЬКО пока area ещё указан (хаб принял, участку
            # только предстоит локальная довыдача, см. receive_transfer_line
            # и тот же признак physically_at_area в
            # _task_borrowable_and_shortfall ниже). Настоящий возврат
            # (return_unit, area=None) — рулон реально ушёл на склад,
            # раньше оставался в issued_units навсегда и продолжал
            # предлагаться в отчёте как будто всё ещё у участка.
            or_(
                MaterialUnit.status.in_([UnitStatus.VYDAN_UCHASTKU, UnitStatus.V_PEREMESHCHENII]),
                and_(MaterialUnit.status == UnitStatus.NA_KHRANENII, MaterialUnit.area.isnot(None)),
            ),
        )
        .all()
    )
    result: dict[int, list[MaterialUnit]] = {}
    for u in units:
        result.setdefault(u.production_task_line_id, []).append(u)
    return result


def _task_borrowable_and_shortfall(
    db: Session,
    task: ProductionTask,
    report_aggregates: dict[int, tuple[float, float]],
    issued_length_by_line: dict[int, float],
    issued_units_by_line: dict[int, list[MaterialUnit]],
) -> tuple[dict[int, float], dict[int, list[tuple[MaterialUnit, ProductionTaskLine]]]]:
    """Раздел про общий штрипс на детали одного задания — считает разом
    для всех строк задания: (1) нехватку плёнки по ГРУППЕ ширины штрипса
    (один рулон закрывает потребность всех строк той же ширины),
    (2) какие рулоны соседних строк можно списать в отчёте по этой строке
    (та же плёнка, взаимозаменяемая ширина, метраж ещё есть)."""
    lines = list(task.lines)
    equiv_cache: dict[float, list[float]] = {}

    def equiv(sw: float) -> list[float]:
        if sw not in equiv_cache:
            equiv_cache[sw] = equivalent_widths(db, sw)
        return equiv_cache[sw]

    sw_by_line = {l.id: _line_effective_strip_width(l) for l in lines}

    gs_lines: list[GroupShortfallLine] = []
    for l in lines:
        _good, defect = report_aggregates.get(l.id, (0.0, 0.0))
        gs_lines.append(
            GroupShortfallLine(
                line_id=l.id,
                width_key=min(equiv(sw_by_line[l.id])),
                needed_length_m=(float(l.quantity_pieces) + defect) * float(l.length_m),
                issued_length_m=issued_length_by_line.get(l.id, 0.0),
                is_closed=l.is_closed,
            )
        )
    group_shortfall_by_line = distribute_group_shortfall(gs_lines)

    borrowable_by_line: dict[int, list[tuple[MaterialUnit, ProductionTaskLine]]] = {}
    for l in lines:
        want_widths = set(equiv(sw_by_line[l.id]))
        spec = (l.material_id, l.color_id, l.thickness_id)
        found: list[tuple[MaterialUnit, ProductionTaskLine]] = []
        for src in lines:
            if src.id == l.id or src.is_closed:
                continue
            if (src.material_id, src.color_id, src.thickness_id) != spec:
                continue
            for u in issued_units_by_line.get(src.id, []):
                if float(u.width_mm) not in want_widths:
                    continue
                # физически доступен участку: выдан участку, либо уже на
                # домашнем складе участка ждёт локальной довыдачи
                physically_at_area = u.status == UnitStatus.VYDAN_UCHASTKU or (
                    u.status == UnitStatus.NA_KHRANENII and u.area is not None
                )
                if physically_at_area and _issued_unit_remaining_m(db, u) > 0:
                    found.append((u, src))
        if found:
            borrowable_by_line[l.id] = found
    return group_shortfall_by_line, borrowable_by_line


def _task_out(db: Session, task: ProductionTask) -> ProductionTaskOut:
    model = db.get(ProductModel, task.product_model_id) if task.product_model_id else None
    line_ids = [l.id for l in task.lines]
    report_aggregates = _line_report_aggregates(db, line_ids)
    assignment_aggregates = _line_assignment_aggregates(db, line_ids)
    assignment_ids = [a.id for l in task.lines for a in l.assignments]
    assignment_report_aggs = _assignment_report_aggregates(db, assignment_ids)
    issued_length_by_line = fetch_issued_length_by_task_line(db, line_ids)
    issued_units_by_line = _line_issued_units_map(db, line_ids)
    group_shortfall_by_line, borrowable_by_line = _task_borrowable_and_shortfall(
        db, task, report_aggregates, issued_length_by_line, issued_units_by_line
    )
    line_outs = [
        _task_line_out(
            db,
            l,
            *report_aggregates.get(l.id, (0.0, 0.0)),
            assignment_aggregates.get(l.id, 0.0),
            assignment_report_aggs,
            issued_length_by_line.get(l.id, 0.0),
            issued_units_by_line.get(l.id, []),
            group_shortfall_by_line.get(l.id, 0.0),
            borrowable_by_line.get(l.id, []),
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
        # Раздел про сводку по заданию (штрипсы + % брака) — та же сумма
        # по строкам, что planned_length_m/issued_length_m выше, только
        # по факту произведённых/бракованных штук (per-line уже считает
        # produced_good_pieces/defect_pieces через _line_report_aggregates).
        produced_good_pieces=round(sum(l.produced_good_pieces for l in line_outs), 2),
        defect_pieces=round(sum(l.defect_pieces for l in line_outs), 2),
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
    db.flush()
    sync_bom_components(db, [model_id])
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
    db.flush()
    sync_bom_components(db, [model_id])
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
    db.flush()
    sync_bom_components(db, [model_id])
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
        if line.material_id is None:
            continue  # строка без плёнки
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


@router.get("/production-operations", response_model=list[AreaOperationOut])
def list_area_operations(
    area: str, db: Session = Depends(get_db), user: User = Depends(view_tasks)
) -> list[AreaOperationOut]:
    """Операции техкарт, выполняемые на участке, — этапы деталей п/ф, кроме
    последнего этапа многоэтапной детали (там она уже готова и расходуется
    следующим переделом)."""
    out = []
    for s in (
        db.query(PartStage)
        .join(Part, Part.id == PartStage.part_id)
        .filter(PartStage.area == area, Part.is_active.is_(True))
        .order_by(Part.name, PartStage.sequence_order)
    ):
        orders = sorted(x.sequence_order for x in s.part.stages)
        if len(orders) > 1 and s.sequence_order == orders[-1]:
            continue
        out.append(
            AreaOperationOut(
                part_stage_id=s.id, part_id=s.part_id, part_name=s.part.name, stage_name=s.name,
                is_first=s.sequence_order == orders[0],
            )
        )
    return out


@router.post("/production-tasks/operations", response_model=ProductionTaskOut, status_code=status.HTTP_201_CREATED)
def create_operation_task(
    payload: OperationTaskCreate, db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> ProductionTaskOut:
    """Задание без плёнки на любой участок (этап 3 единой модели) — то же
    «Задание цеха», строки ссылаются на операцию техкарты или просто
    называют работу. length_m = 0: расход плёнки на штуку."""
    area = db.get(Area, payload.area)
    if area is None or not area.is_active:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Участок не найден")
    task = ProductionTask(name=payload.name, area=payload.area, created_by=user.id)
    db.add(task)
    db.flush()
    for lp in payload.lines:
        if lp.part_stage_id is not None:
            try:
                stage = validate_line_stage(db, task_area=payload.area, part_stage_id=lp.part_stage_id)
            except ValueError as e:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)) from e
            db.add(
                ProductionTaskLine(
                    task_id=task.id, quantity_pieces=lp.quantity_pieces, part_stage_id=stage.id,
                    part_id=stage.part_id, part_name=stage.part.name,
                    width_mm=stage.part.width_mm or 0, length_m=0,
                )
            )
        elif lp.name and lp.name.strip():
            db.add(
                ProductionTaskLine(
                    task_id=task.id, quantity_pieces=lp.quantity_pieces, part_name=lp.name.strip(),
                    width_mm=0, length_m=0,
                )
            )
        else:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Строка: выберите операцию или впишите работу")
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


def _build_operation_report(
    line: ProductionTaskLine,
    payload: ProductionTaskLineReportCreate,
    db: Session,
    user: User,
) -> list[ProductionTaskLineReport]:
    """Отчёт по строке с операцией техкарты (этап 3 единой модели — задание
    на любой участок): партии детали двигаются по её маршруту так же, как в
    бывших «Заданиях участкам» — первая операция рождает партию, средняя
    переводит дальше по FIFO, брак списывается с партий этой операции. Рулон
    не нужен. Без commit — как и весь _build_task_line_report."""
    if payload.material_unit_id is not None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="У строки без плёнки рулон не указывается")
    if payload.defect_pieces > 0 and not payload.defect_reason:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Укажите причину брака")
    if payload.defect_pieces > 0 and payload.defect_disposition == "pererabotka":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Переработка брака пока только на окутке — здесь брак списывается",
        )
    stage = db.get(PartStage, line.part_stage_id)
    if stage is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Операция строки не найдена")
    if payload.counts_toward_line:
        try:
            apply_report_to_part_units(
                db, stage=stage, area=line.task.area, good_pieces=payload.good_pieces,
                defect_pieces=payload.defect_pieces, defect_reason=payload.defect_reason, note=payload.note,
                user_id=user.id, occurred_at=datetime.now(timezone.utc),
            )
        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)) from e
    report = ProductionTaskLineReport(
        task_line_id=line.id,
        assignment_id=payload.assignment_id,
        good_pieces=payload.good_pieces,
        defect_pieces=payload.defect_pieces,
        defect_reason=payload.defect_reason,
        note=payload.note,
        reported_by=user.id,
        counts_toward_line=payload.counts_toward_line,
    )
    db.add(report)
    db.flush()
    return [report]


def _build_task_line_report(
    task_id: int,
    line_id: int,
    payload: ProductionTaskLineReportCreate,
    db: Session,
    user: User,
) -> list[ProductionTaskLineReport]:
    """Собрать (и добавить в сессию через db.add_all, БЕЗ db.commit) строки
    отчёта для одного payload — раздел про атомарное сохранение пачки
    отчётов одним запросом (см. create_task_line_reports_batch): раньше
    "Задания цеха"/"Ежедневка" слали несколько независимых HTTP-запросов
    одним Promise.all на один клик "Сохранить" (основной good_pieces +
    по одной записи на каждую причину брака + по одной на каждый
    доп. рулон/остаток) — если ОДИН из них падал (чаще всего "недостаточно
    партий п/ф" на основном good_pieces), остальные уже успевали
    закоммититься по отдельности, а форма это никак не отслеживала:
    повторный клик "Сохранить" переслал ВСЕ вызовы заново, задваивая уже
    прошедшие (реальный случай — брак 15 шт списался 8 раз как 120, потому
    что 7 из 8 попыток были именно такими повторами). Здесь — та же логика
    построения строк отчёта, что раньше жила прямо в create_task_line_report,
    вынесена в общую функцию без собственного commit, чтобы вызывающий код
    мог собрать НЕСКОЛЬКО payload'ов одного клика в одну транзакцию и
    закоммитить (или откатить) их разом."""
    line = _get_task_line(db, task_id, line_id)
    area = db.get(Area, line.task.area)
    requires_daily_plan = area is None or area.requires_daily_plan
    if payload.assignment_id is not None:
        assignment = db.get(ProductionTaskLineAssignment, payload.assignment_id)
        if assignment is None or assignment.task_line_id != line_id:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Распределение не найдено для этой строки задания")
    elif requires_daily_plan:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Для этого участка отчёт должен быть привязан к распределению по дням")
    if line.part_stage_id is not None:
        return _build_operation_report(line, payload, db, user)
    if payload.material_unit_id is not None:
        unit = db.get(MaterialUnit, payload.material_unit_id)
        # Раздел про сверку рулонов на окутке — допускаем ещё и На_хранении
        # (не только Выдан_участку): пилот "Ежедневки" запущен позже, чем
        # часть рулонов успели вернуть, поэтому отчёт по ним заводится
        # задним числом уже после физического возврата (см. панель
        # "Сверка рулонов"). Раньше это падало 422 "рулон не найден среди
        # выданных" — рулон-то физически давно на складе, отчёт всё равно
        # нужно занести.
        status_ok = unit is not None and unit.status in (UnitStatus.VYDAN_UCHASTKU, UnitStatus.NA_KHRANENII)
        # Раздел про общий штрипс на детали одного задания — рулон, выданный
        # ДРУГОЙ строке ТОГО ЖЕ задания, годится, если это та же плёнка и
        # взаимозаменяемая ширина штрипса (equivalent_widths). Мастер решает,
        # хватает ли метража. Признака "новый" у рулона нет — работает и с
        # рулонами, выданными до этой доработки.
        line_ok = False
        if unit is not None and status_ok:
            if unit.production_task_line_id == line_id:
                line_ok = True
            elif unit.production_task_line_id is not None:
                src_line = db.get(ProductionTaskLine, unit.production_task_line_id)
                line_ok = (
                    src_line is not None
                    and src_line.task_id == line.task_id
                    and (src_line.material_id, src_line.color_id, src_line.thickness_id)
                    == (line.material_id, line.color_id, line.thickness_id)
                    and float(unit.width_mm) in set(equivalent_widths(db, _line_effective_strip_width(line)))
                )
        if not (status_ok and line_ok):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Рулон не найден среди выданных на эту строку")
    elif line.task.area == AREA_REQUIRES_ROLL_ON_REPORT and line.material_id is not None:
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
    # Раздел про ревизию путей п/ф — part_unit_id клиента оставлен только
    # для обратной совместимости (деталь без настроенных этапов/прямой
    # вызов API в обход текущего фронта, тот же приём, что уже есть для
    # good_pieces ниже): текущий интерфейс партию для брака больше не
    # предлагает выбирать вручную вовсе — деталь на участке одна, брак
    # списывается по FIFO так же, как приходуются готовые (см.
    # consume_defect_fifo).
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
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Укажите причину брака")

    # Раздел про учёт п/ф по FIFO — для готовых деталей партия больше не
    # выбирается вручную: если у детали настроены этапы, расходуем от
    # самой старой партии по дате изготовления (consume_part_units_fifo),
    # part_unit_id клиента для good_pieces игнорируется. Брак — по-прежнему
    # вручную (part_unit выше, уже проверенный). fifo_results — одна
    # запись на каждую тронутую партию (обычно одна, несколько — если
    # одной не хватило на весь good_pieces); каждая становится своей
    # строкой ProductionTaskLineReport ниже.
    #
    # has_part_unit_stock — этапы у детали настроены в справочнике много
    # где (массовая настройка на все детали разом), но реально партии
    # п/ф через "Учёт п/ф" заводят не по каждой: если для этой детали на
    # этом участке НЕТ вообще ни одной партии, это значит физический
    # учёт п/ф тут ещё не ведётся (не "партии кончились") — считаем как
    # деталь без этапов, отчёт обычный, без FIFO. Если хотя бы одна
    # партия есть, но её не хватает на весь good_pieces — это уже
    # настоящая нехватка, ошибка оправдана.
    # Раздел про единую номенклатуру — по ссылке, а не по тексту названия;
    # запасной вариант по названию — для строк, где ссылки ещё нет.
    part = db.get(Part, line.part_id) if line.part_id else None
    if part is None and line.part_name:
        part = db.query(Part).filter(Part.name == line.part_name).first()
    # Строка без плёнки и без операции (упаковка и т.п.) — просто счёт штук,
    # партии п/ф двигает только строка с операцией техкарты (выше).
    has_part_unit_stock = (
        line.material_id is not None
        and part is not None
        and part.stages
        and db.query(PartUnit.id)
        .filter(PartUnit.part_id == part.id, PartUnit.area == line.task.area, PartUnit.status == PartUnitStatus.VYDAN_UCHASTKU)
        .first()
        is not None
    )
    # Раздел про общий штрипс/доп. рулон на ту же строку — синтетический
    # good_pieces такого отчёта (counts_toward_line=false) НЕ означает
    # "стало на столько-то готовых деталей больше" — это подгонка под
    # указанный вручную остаток конкретного рулона в метрах, те же самые
    # детали уже засчитаны основным отчётом. Без этой проверки FIFO
    # расходовал бы партию п/ф ЕЩЁ РАЗ на те же самые физические детали
    # (задвоение расхода партии вплоть до "недостаточно партий").
    fifo_results: list[tuple[PartUnit, bool, float]] = []
    if payload.good_pieces > 0 and has_part_unit_stock and payload.counts_toward_line:
        try:
            fifo_results = consume_part_units_fifo(
                db, part_id=part.id, area=line.task.area, quantity_pieces=payload.good_pieces, user_id=user.id
            )
        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)) from e
    elif payload.good_pieces > 0 and part_unit is not None and payload.counts_toward_line:
        # Совместимость: явный part_unit_id для готовых деталей у детали
        # без настроенных этапов (или прямой вызов API в обход текущего
        # фронта) — раньше это был единственный путь, оставляем рабочим.
        try:
            _, is_final = advance_part_unit(db, unit=part_unit, quantity_pieces=payload.good_pieces, user_id=user.id)
        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)) from e
        fifo_results = [(part_unit, is_final, payload.good_pieces)]

    # Раздел про списание готовых п/ф по плану строки задания — партия,
    # дошедшая до последнего этапа (is_final), раньше молча оставалась
    # висеть Выдан_участку навсегда (advance_part_unit не меняет статус
    # на терминальном переходе — см. его докстрину). Теперь: ровно план
    # строки (line.quantity_pieces) авто-списывается системной причиной
    # (партия физически ушла под это задание), а всё сверх плана
    # переводится в обычный доступный остаток (На_хранении, не
    # размещено, но участок НЕ сбрасывается — см. settle_excess_part_
    # unit_at_area: участок и есть склад для готовых п/ф).
    #
    # Раздел про порядок обработки внутри ОДНОГО payload'а — этот блок
    # обязан идти СРАЗУ после расхода "хороших", до обработки брака ниже:
    # тронутые тут партии (списанные/переведённые в На_хранении) должны
    # выпасть из кандидатов на брак ДО того, как consume_defect_fifo/
    # reserve_defect_for_recycle_fifo сделают свой собственный запрос (там
    # фильтр по статусу VYDAN_UCHASTKU) — иначе брак может выбрать ТУ ЖЕ
    # партию, которую уже полностью списал этот блок, и получить "Партия
    # уже списана" на объекте, который здесь уже мутировали.
    #
    # processed_fifo_results заменяет fifo_results для построения строк
    # отчёта ниже — партия, которую эта проводка разделила на списанную и
    # излишек, должна дать ДВЕ строки ProductionTaskLineReport (по одной
    # на каждый реально затронутый part_unit_id, тот же приём, что уже
    # используется для defect_fifo_results/нескольких партий одного
    # прихода). Если строить одну строку на исходный pu.id со старым
    # taken — reported_good_pieces_by_unit для этого id разошлась бы с
    # его новым (уменьшённым) quantity_pieces и сломала бы будущий FIFO
    # по этой же партии (появилась бы отрицательная "свободная" величина).
    #
    # already_counted — сколько по этой строке уже засчитано ДО этого
    # payload (та же агрегация, что использует сводка строки задания,
    # см. _task_line_out/_line_reports_agg выше), running растёт по мере
    # обработки каждой затронутой партии этого же payload.
    processed_fifo_results: list[tuple[PartUnit, bool, float]] = []
    if fifo_results:
        already_counted = float(
            db.query(func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
            .filter(
                ProductionTaskLineReport.task_line_id == line_id,
                ProductionTaskLineReport.counts_toward_line.is_(True),
            )
            .scalar()
        )
        running = already_counted
        plan = float(line.quantity_pieces)
        for pu, is_final, taken in fifo_results:
            if not is_final:
                processed_fifo_results.append((pu, is_final, taken))
                continue
            budget = max(0.0, plan - running)
            write_off_amount = min(taken, budget)
            excess_amount = taken - write_off_amount
            running += taken
            if write_off_amount > 0:
                wo_unit = write_off_part_unit(
                    db,
                    unit=pu,
                    quantity_pieces=write_off_amount,
                    reason=PART_UNIT_AUTO_WRITE_OFF_REASON_CODE,
                    user_id=user.id,
                    note=f"Автосписание по строке задания №{line_id}",
                )
                processed_fifo_results.append((wo_unit, True, write_off_amount))
            if excess_amount > 0:
                settle_excess_part_unit_at_area(db, unit=pu, user_id=user.id)
                processed_fifo_results.append((pu, True, excess_amount))

    # Раздел про строки отчёта для "хороших" — собираются и добавляются в
    # сессию ЗДЕСЬ, сразу после расхода "хороших" и ДО обработки брака
    # ниже (не вместе со строками брака в конце, как раньше) по двум
    # причинам разом:
    #   1) Раздел про autoflush=False (app/db/session.py) — без явного
    #      flush ниже запрос consume_defect_fifo/reserve_defect_for_
    #      recycle_fifo увидел бы в БД ЕЩЁ старый статус Выдан_участку у
    #      партии, которую только что списал/перевёл в На_хранении блок
    #      выше (сам SQL-запрос идёт мимо identity map) и повторно выбрал
    #      бы её кандидатом — ValueError "Партия уже списана" на объекте,
    #      уже мутированном в памяти этим же циклом (реальный случай на
    #      проде, воспроизведён и исправлен).
    #   2) Более общая и более старая гонка (существовала ДО этой правки,
    #      независимо от неё): reported_good_pieces_by_unit (см.
    #      consume_defect_fifo/consume_part_units_fifo, services/part_
    #      units.py) считает "уже отчитанное" по СТРОКАМ ProductionTaskLine
    #      Report в БД — если строки good_pieces не вставлены и не
    #      сброшены ДО того, как FIFO брака сделает свой запрос "сколько
    #      свободно" по той же самой партии, где good ЦЕЛИКОМ (полное
    #      совпадение, advance_part_unit намеренно не уменьшает quantity_
    #      pieces на терминальном переходе) забрал уже ВСЁ — брак увидит
    #      партию как полностью свободную ЕЩЁ РАЗ и по-настоящему заберёт
    #      с неё лишнее (не ошибка, а тихая порча остатка). Обнаружено по
    #      факту на прод-данных (партии №505/№653 — carry-over расхождение
    #      quantity_pieces с суммой good по отчётам на 1 и 5 шт
    #      соответственно, из периода ДО всех правок этой сессии).
    good_reports: list[ProductionTaskLineReport] = [
        ProductionTaskLineReport(
            task_line_id=line_id,
            assignment_id=payload.assignment_id,
            material_unit_id=payload.material_unit_id,
            part_unit_id=pu.id,
            good_pieces=taken,
            defect_pieces=0,
            reported_by=user.id,
            counts_toward_line=is_final,
        )
        for pu, is_final, taken in processed_fifo_results
    ]
    if good_reports:
        db.add_all(good_reports)
        db.flush()

    # Раздел про ревизию путей п/ф — брак списывается по FIFO так же, как
    # приходуются готовые детали выше (было: партию для брака выбирал
    # вручную мастер — деталь физически на участке одна, выбор был лишним
    # шагом; не выбрал — брак вообще не списывался с п/ф).
    defect_fifo_results: list[tuple[PartUnit, float]] = []
    if payload.defect_pieces > 0 and has_part_unit_stock:
        # Раздел про переработку брака — "pererabotka" резервирует брак
        # (статус В_переработку) вместо необратимого списания; забрать
        # резерв в готовую деталь можно позже отдельным действием
        # "Переработать в деталь". Обе ветки — тот же FIFO по
        # manufactured_at, отличается только конечный статус партии.
        consume_fn = (
            reserve_defect_for_recycle_fifo if payload.defect_disposition == "pererabotka" else consume_defect_fifo
        )
        try:
            defect_fifo_results = consume_fn(
                db,
                part_id=part.id,
                area=line.task.area,
                quantity_pieces=payload.defect_pieces,
                user_id=user.id,
                reason=payload.defect_reason,
                note=payload.note,
            )
        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)) from e
    elif part_unit is not None and payload.defect_pieces > 0:
        # Совместимость: явный part_unit_id у детали без настроенных
        # этапов (или прямой вызов API в обход текущего фронта).
        try:
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
        defect_fifo_results = [(part_unit, payload.defect_pieces)]

    # Раздел про окутку в 2 захода — good_pieces с part_unit считается
    # "готовым" для остатка СТРОКИ ЗАДАНИЯ (counts_toward_line) только
    # если партия дошла до последнего этапа (is_final). Промежуточный
    # переход (деталь физически ещё не готова) двигает партию по этапам
    # и по-прежнему учитывается в расходе рулона (compute_unit_consumed_
    # length_m и has_report в return_unit не фильтруют по
    # counts_toward_line), но не уменьшает "нужно ещё" по заданию.
    reports: list[ProductionTaskLineReport] = list(good_reports)
    if fifo_results or defect_fifo_results:
        # Раздел про ревизию путей п/ф — одна строка ProductionTaskLineReport
        # на каждую затронутую списанием партию (обычно одна, несколько —
        # если брака больше, чем в самой старой партии, см. consume_defect_
        # fifo), а не одна строка на весь payload.defect_pieces сразу.
        for pu, taken in defect_fifo_results:
            reports.append(
                ProductionTaskLineReport(
                    task_line_id=line_id,
                    assignment_id=payload.assignment_id,
                    material_unit_id=payload.material_unit_id,
                    part_unit_id=pu.id,
                    good_pieces=0,
                    defect_pieces=taken,
                    defect_reason=payload.defect_reason,
                    note=payload.note,
                    reported_by=user.id,
                    counts_toward_line=True,
                )
            )
    else:
        # Обычный путь (без п/ф-этапов, либо отчёт без good_pieces вовсе)
        # — ровно как раньше, одна строка на весь payload. counts_toward_
        # line берётся из payload (раздел про доп. рулон на ту же строку)
        # — клиент явно шлёт False для синтетических отчётов "остаток
        # такого-то рулона указан вручную", чтобы не задвоить план строки;
        # для всех обычных отчётов поле как раньше остаётся True (значение
        # по умолчанию в схеме).
        reports.append(
            ProductionTaskLineReport(
                task_line_id=line_id,
                assignment_id=payload.assignment_id,
                material_unit_id=payload.material_unit_id,
                part_unit_id=payload.part_unit_id,
                good_pieces=payload.good_pieces,
                defect_pieces=payload.defect_pieces,
                defect_reason=payload.defect_reason,
                note=payload.note,
                reported_by=user.id,
                counts_toward_line=payload.counts_toward_line,
            )
        )
    db.add_all(reports)
    return reports


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
    reports = _build_task_line_report(task_id, line_id, payload, db, user)
    db.commit()
    for r in reports:
        db.refresh(r)
    return reports[-1]


@router.post(
    "/production-tasks/{task_id}/lines/{line_id}/reports/batch",
    response_model=list[ProductionTaskLineReportOut],
    status_code=status.HTTP_201_CREATED,
)
def create_task_line_reports_batch(
    task_id: int,
    line_id: int,
    payloads: list[ProductionTaskLineReportCreate],
    db: Session = Depends(get_db),
    user: User = Depends(report_production),
) -> list[ProductionTaskLineReport]:
    """Один клик "Сохранить отчёт" в "Заданиях цеха"/"Ежедневке" почти
    всегда означает НЕСКОЛЬКО payload'ов сразу на одну строку (основной
    good_pieces + по одной записи на каждую причину брака + по одной на
    каждый доп. рулон/остаток) — раньше фронт слал их отдельными
    независимыми запросами (Promise.all), и если ОДИН из них падал
    (обычно "недостаточно партий п/ф" на основном good_pieces), остальные
    уже успевали закоммититься по отдельности за секунду до этого — форма
    об этом не знала и просто показывала общую ошибку. Повторный клик
    "Сохранить" пересылал ВСЕ payload'ы заново, задваивая уже прошедшие
    (реальный случай — 15 шт брака списались 8 раз как 120, потому что 7
    из 8 попыток были именно такими повторами частично успешного пакета).

    Здесь — вся пачка одной транзакцией: если ХОТЯ БЫ ОДИН payload падает,
    ничего не коммитится вообще (db.commit() только один раз, в самом
    конце) — исходная строка просто остаётся как была, повторный клик
    безопасен."""
    reports: list[ProductionTaskLineReport] = []
    for payload in payloads:
        reports.extend(_build_task_line_report(task_id, line_id, payload, db, user))
    db.commit()
    for r in reports:
        db.refresh(r)
    return reports


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


@router.patch("/production-tasks/{task_id}/lines/{line_id}/close", response_model=ProductionTaskOut)
def close_task_line(
    task_id: int,
    line_id: int,
    is_closed: bool,
    db: Session = Depends(get_db),
    user: User = Depends(manage_production),
) -> ProductionTaskOut:
    """Закрыть/переоткрыть ОДНУ строку задания по выдаче (раздел про
    закрытие строки задания по выдаче) — та же механика, что
    archive_production_task выше, но не для всего задания целиком: часто
    в одном задании соседствуют строки, которые реально ещё идут, и
    строки, по которым всё уже физически улажено (выдано, возвращено,
    списано) заднем числом, пока отчёты только дозаводятся. Флаг не
    трогает shortfall_length_m/remaining_pieces/отчёты — это ручное
    решение поверх них, скрывающее строку из Issue.tsx (не из
    TasksTab.tsx — там она остаётся видна с пометкой)."""
    line = db.get(ProductionTaskLine, line_id)
    if line is None or line.task_id != task_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Строка задания не найдена")
    line.is_closed = is_closed
    db.commit()
    task = db.get(ProductionTask, task_id)
    return _task_out(db, task)


@router.patch("/production-tasks/{task_id}/lines/{line_id}/close-production", response_model=ProductionTaskOut)
def close_production_line(
    task_id: int,
    line_id: int,
    production_closed: bool,
    db: Session = Depends(get_db),
    user: User = Depends(manage_production),
) -> ProductionTaskOut:
    """Явно завершить/возобновить работу по строке в ПРОИЗВОДСТВЕ
    (раздел про автоматический уход строк из очереди «Выдачи» + явное
    завершение) — независимая ось от close_task_line/is_closed выше
    (тот про выдачу/остаток рулона): этот флаг про то, что строку
    больше не предлагают для новых отчётов о производстве (TasksTab.tsx
    "Отчитаться о производстве"/"Распределить по дням",
    MasterQuickReportPanel.tsx). Отчёт о производстве обычно подаётся
    по дням (сегодня 30 шт, завтра ещё) — значит, саму возможность
    отчитаться нельзя блокировать автоматически по remaining_pieces
    (план могут пересмотреть в бо́льшую сторону уже после того, как
    изначальный был выполнен) — только этим ручным флагом, который
    сам никогда не выставляется автоматически."""
    line = db.get(ProductionTaskLine, line_id)
    if line is None or line.task_id != task_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Строка задания не найдена")
    line.production_closed = production_closed
    db.commit()
    task = db.get(ProductionTask, task_id)
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
