from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.dictionaries import Color, Material, Thickness
from app.models.units import MaterialUnit
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
    ProductionLineCreate,
    ProductionLineOut,
    ProductionLineUpdate,
    ProductionTaskLineAssignmentCreate,
    ProductionTaskLineAssignmentOut,
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
from app.services.dictionaries import find_or_create_material_color_thickness
from app.services.plan_fact import fetch_issued_length_by_task_line
from app.services.production import calc_default_strip_width, compute_remaining_length_m, compute_remaining_pieces

router = APIRouter(tags=["production"])

# Пилот: окутка царговых (раздел про производственные задания) — модели
# продукции/BOM и сами задания заводит начальник цеха, та же по духу
# зона ответственности, что и orders.plan (строки потребности заказа).
manage_production = require_permission("production_tasks.manage")
# Отчёт о факте производства/браке (раздел про брак в производстве) —
# начальник участка (уже смотрит задания своего участка) или начальник
# цеха.
report_production = require_permission("production_tasks.manage", "production_tasks.report")


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
) -> ProductionTaskLineOut:
    assignment_report_aggs = assignment_report_aggs or {}
    prod_line = db.get(ProductionLine, line.line_id) if line.line_id else None
    remaining_pieces = compute_remaining_pieces(float(line.quantity_pieces), good)
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
        assigned_pieces=assigned,
        unassigned_pieces=compute_remaining_pieces(float(line.quantity_pieces), assigned),
        assignments=[
            _assignment_out(db, a, *assignment_report_aggs.get(a.id, (0.0, 0.0))) for a in line.assignments
        ],
        issued_length_m=issued_length_m,
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


def _assignment_report_aggregates(db: Session, assignment_ids: list[int]) -> dict[int, tuple[float, float]]:
    """Σ good_pieces/defect_pieces по конкретной записи распределения
    (раздел про брак по дням) — тот же батч-приём, что
    _line_report_aggregates, только группировка по assignment_id, не
    task_line_id, чтобы видеть факт/брак за конкретный день/линию."""
    if not assignment_ids:
        return {}
    rows = (
        db.query(
            ProductionTaskLineReport.assignment_id,
            func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
            func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0),
        )
        .filter(ProductionTaskLineReport.assignment_id.in_(assignment_ids))
        .group_by(ProductionTaskLineReport.assignment_id)
        .all()
    )
    return {row[0]: (float(row[1]), float(row[2])) for row in rows}


def _task_out(db: Session, task: ProductionTask) -> ProductionTaskOut:
    model = db.get(ProductModel, task.product_model_id) if task.product_model_id else None
    line_ids = [l.id for l in task.lines]
    report_aggregates = _line_report_aggregates(db, line_ids)
    assignment_aggregates = _line_assignment_aggregates(db, line_ids)
    assignment_ids = [a.id for l in task.lines for a in l.assignments]
    assignment_report_aggs = _assignment_report_aggregates(db, assignment_ids)
    issued_length_by_line = fetch_issued_length_by_task_line(db, line_ids)
    return ProductionTaskOut(
        id=task.id,
        product_model_id=task.product_model_id,
        product_model_name=model.name if model else None,
        name=task.name,
        area=task.area,
        quantity=task.quantity,
        order_id=task.order_id,
        created_by=task.created_by,
        created_at=task.created_at,
        lines=[
            _task_line_out(
                db,
                l,
                *report_aggregates.get(l.id, (0.0, 0.0)),
                assignment_aggregates.get(l.id, 0.0),
                assignment_report_aggs,
                issued_length_by_line.get(l.id, 0.0),
            )
            for l in task.lines
        ],
    )


# --- Линии -------------------------------------------------------------


@router.get("/production-lines", response_model=list[ProductionLineOut])
def list_production_lines(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[ProductionLine]:
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
def list_product_models(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[ProductModelOut]:
    models = db.query(ProductModel).options(joinedload(ProductModel.parts)).order_by(ProductModel.name).all()
    return [_model_out(db, m) for m in models]


@router.get("/product-models/{model_id}", response_model=ProductModelOut)
def get_product_model(model_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ProductModelOut:
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
    model = ProductModel(name=payload.name, area=payload.area)
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
def list_production_tasks(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[ProductionTaskOut]:
    tasks = (
        db.query(ProductionTask)
        .options(joinedload(ProductionTask.lines))
        .order_by(ProductionTask.created_at.desc())
        .all()
    )
    return [_task_out(db, t) for t in tasks]


@router.post("/production-tasks/manual", response_model=ProductionTaskOut, status_code=status.HTTP_201_CREATED)
def create_production_task_manual(
    payload: ProductionTaskManualCreate, db: Session = Depends(get_db), user: User = Depends(manage_production)
) -> ProductionTaskOut:
    task = ProductionTask(
        product_model_id=payload.product_model_id,
        quantity=payload.quantity,
        name=payload.name,
        area=payload.area,
        order_id=payload.order_id,
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
    task_id: int, line_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> list[ProductionTaskLineReport]:
    _get_task_line(db, task_id, line_id)
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
    Обязательно привязан к конкретной записи распределения (раздел про
    брак по дням) — мастер отчитывается за конкретный день/линию, не за
    строку задания в целом."""
    _get_task_line(db, task_id, line_id)
    assignment = db.get(ProductionTaskLineAssignment, payload.assignment_id)
    if assignment is None or assignment.task_line_id != line_id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Распределение не найдено для этой строки задания")
    report = ProductionTaskLineReport(
        task_line_id=line_id,
        assignment_id=payload.assignment_id,
        good_pieces=payload.good_pieces,
        defect_pieces=payload.defect_pieces,
        defect_reason=payload.defect_reason,
        note=payload.note,
        reported_by=user.id,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


# --- Распределение по линиям ---------------------------------------------


def _assignment_out(
    db: Session, a: ProductionTaskLineAssignment, produced_good_pieces: float = 0.0, defect_pieces: float = 0.0
) -> ProductionTaskLineAssignmentOut:
    line = db.get(ProductionLine, a.line_id)
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
    )


@router.get(
    "/production-tasks/{task_id}/lines/{line_id}/assignments", response_model=list[ProductionTaskLineAssignmentOut]
)
def list_task_line_assignments(
    task_id: int, line_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> list[ProductionTaskLineAssignmentOut]:
    _get_task_line(db, task_id, line_id)
    assignments = (
        db.query(ProductionTaskLineAssignment)
        .filter(ProductionTaskLineAssignment.task_line_id == line_id)
        .order_by(ProductionTaskLineAssignment.date.desc(), ProductionTaskLineAssignment.created_at.desc())
        .all()
    )
    report_aggs = _assignment_report_aggregates(db, [a.id for a in assignments])
    return [_assignment_out(db, a, *report_aggs.get(a.id, (0.0, 0.0))) for a in assignments]


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
def get_production_task(task_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ProductionTaskOut:
    task = db.get(ProductionTask, task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Задание не найдено")
    return _task_out(db, task)


@router.delete("/production-tasks/{task_id}")
def delete_production_task(
    task_id: int, db: Session = Depends(get_db), user: User = Depends(manage_production)
):
    task = db.get(ProductionTask, task_id)
    if task is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    # Единицы, реально выданные по строкам этого задания, — та же логика,
    # что у удаления заказа: если по заданию уже была движуха, его не
    # удаляют, а оставляют как есть (архивной отметки у задания нет, в
    # отличие от заказа/стеллажа/линии — задание либо ещё пустое, либо
    # часть истории склада).
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
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/product-models/{model_id}")
def delete_product_model(
    model_id: int, db: Session = Depends(get_db), user: User = Depends(manage_production)
):
    model = db.get(ProductModel, model_id)
    if model is not None:
        db.delete(model)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
