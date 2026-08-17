from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.labels import LabelTemplate
from app.models.storage import Rack, Warehouse
from app.models.units import MaterialUnit
from app.schemas.labels import AvailableFieldOut, LabelBatchRequest, LabelTemplateOut, LabelTemplateUpdate, RackLabelBatchRequest
from app.services.labels import (
    DEFAULT_FIELDS,
    DEFAULT_FIELDS_RACK,
    DEFAULT_HEIGHT_MM,
    DEFAULT_RACK_HEIGHT_MM,
    DEFAULT_RACK_WIDTH_MM,
    DEFAULT_WIDTH_MM,
    FIELD_META,
    FIELD_META_RACK,
    PREVIEW_DATA,
    PREVIEW_DATA_RACK,
    RACK_TYPE_LABELS,
    RackLabelData,
    label_data_from_unit,
    render_label_html,
    render_label_pdf,
    render_labels_html_batch,
    render_labels_pdf_batch,
    render_rack_label_pdf,
    render_rack_labels_html_batch,
    render_rack_labels_pdf_batch,
)

router = APIRouter(tags=["labels"])

# Часть администрирования (5.6 ТЗ) — доступ только логисту/руководителю.
manage_labels = require_permission("labels.manage")


def _get_template(db: Session, kind: str) -> LabelTemplate:
    template = db.query(LabelTemplate).filter(LabelTemplate.kind == kind).first()
    if template is None:
        defaults = (
            (DEFAULT_WIDTH_MM, DEFAULT_HEIGHT_MM, DEFAULT_FIELDS)
            if kind == "unit"
            else (DEFAULT_RACK_WIDTH_MM, DEFAULT_RACK_HEIGHT_MM, DEFAULT_FIELDS_RACK)
        )
        width_mm, height_mm, fields = defaults
        template = LabelTemplate(kind=kind, width_mm=width_mm, height_mm=height_mm, fields=fields)
        db.add(template)
        db.commit()
        db.refresh(template)
    elif kind == "unit" and template.width_mm == 60 and template.height_mm == 90:
        # Раньше единственный singleton-макет (id=1) мог остаться со старым
        # дефолтом 60×90 — актуально только для рулонов, у стеллажного
        # макета такой истории нет.
        template.width_mm = 100
        template.height_mm = 40
        db.commit()
        db.refresh(template)
    return template


@router.get("/label-template", response_model=LabelTemplateOut)
def get_label_template(kind: str = "unit", db: Session = Depends(get_db), user=Depends(get_current_user)) -> LabelTemplate:
    return _get_template(db, kind)


@router.get("/label-template/available-fields", response_model=list[AvailableFieldOut])
def list_available_fields(kind: str = "unit", user=Depends(get_current_user)) -> list[AvailableFieldOut]:
    meta = FIELD_META if kind == "unit" else FIELD_META_RACK
    return [AvailableFieldOut(key=key, **m) for key, m in meta.items()]


@router.patch("/label-template", response_model=LabelTemplateOut)
def update_label_template(
    payload: LabelTemplateUpdate, kind: str = "unit", db: Session = Depends(get_db), user=Depends(manage_labels)
) -> LabelTemplate:
    template = _get_template(db, kind)
    template.width_mm = payload.width_mm
    template.height_mm = payload.height_mm
    template.fields = [f.model_dump() for f in payload.fields]
    db.commit()
    db.refresh(template)
    return template


@router.post("/label-template/preview")
def preview_label_template(payload: LabelTemplateUpdate, kind: str = "unit", user=Depends(manage_labels)) -> Response:
    """Превью макета на синтетических данных (4 раздел бэклога доработок) —
    не требует реальной единицы/стеллажа и не сохраняет изменения.

    Отдаёт настоящий PDF, не HTML-страницу (по итогам полевого тестирования
    печати на термопринтере Codex G500 — прямая печать HTML из браузера
    оказалась ненадёжной, тот же путь, что у "Сохранить как PDF", уже
    подтверждён рабочим). Превью показывает ровно то, что реально уйдёт на
    печать, без расхождений между просмотром и печатью."""
    fields = [f.model_dump() for f in payload.fields]
    if kind == "unit":
        pdf_bytes = render_label_pdf(PREVIEW_DATA, fields=fields, width_mm=payload.width_mm, height_mm=payload.height_mm)
    else:
        pdf_bytes = render_rack_label_pdf(PREVIEW_DATA_RACK, fields=fields, width_mm=payload.width_mm, height_mm=payload.height_mm)
    return Response(content=pdf_bytes, media_type="application/pdf")


@router.get("/labels/{unit_id}", dependencies=[Depends(get_current_user)])
def get_label(unit_id: int, db: Session = Depends(get_db)) -> Response:
    unit = db.get(MaterialUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")
    template = _get_template(db, "unit")
    pdf_bytes = render_label_pdf(
        label_data_from_unit(unit), fields=template.fields, width_mm=template.width_mm, height_mm=template.height_mm
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="label-{unit_id}.pdf"'},
    )


@router.get("/labels/{unit_id}/html", dependencies=[Depends(get_current_user)])
def get_label_html(unit_id: int, db: Session = Depends(get_db)) -> Response:
    """HTML-версия той же этикетки (планшеты — печать PDF-blob через
    window.print() на части Android-браузеров не срабатывает, система
    перехватывает blob как файл на скачивание вместо печати; обычная
    HTML-страница печатается штатным Print Service Framework Android)."""
    unit = db.get(MaterialUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")
    template = _get_template(db, "unit")
    html = render_label_html(
        label_data_from_unit(unit), fields=template.fields, width_mm=template.width_mm, height_mm=template.height_mm
    )
    return Response(content=html, media_type="text/html")


@router.post("/labels/batch/html", dependencies=[Depends(get_current_user)])
def get_labels_batch_html(payload: LabelBatchRequest, db: Session = Depends(get_db)) -> Response:
    units = db.query(MaterialUnit).filter(MaterialUnit.id.in_(payload.unit_ids)).all()
    units_by_id = {u.id: u for u in units}
    ordered_units = [units_by_id[uid] for uid in payload.unit_ids if uid in units_by_id]
    if not ordered_units:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ни одна из единиц не найдена")
    template = _get_template(db, "unit")
    html = render_labels_html_batch(
        [label_data_from_unit(u) for u in ordered_units],
        fields=template.fields,
        width_mm=template.width_mm,
        height_mm=template.height_mm,
    )
    return Response(content=html, media_type="text/html")


@router.post("/labels/batch", dependencies=[Depends(get_current_user)])
def get_labels_batch(payload: LabelBatchRequest, db: Session = Depends(get_db)) -> Response:
    """Очередь печати (раздел про ускорение работы): один PDF на несколько
    единиц вместо открытия отдельной вкладки/запроса на каждую — актуально
    после сессии приёмки на партию из N рулонов."""
    units = db.query(MaterialUnit).filter(MaterialUnit.id.in_(payload.unit_ids)).all()
    units_by_id = {u.id: u for u in units}
    ordered_units = [units_by_id[uid] for uid in payload.unit_ids if uid in units_by_id]
    if not ordered_units:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ни одна из единиц не найдена")
    template = _get_template(db, "unit")
    pdf_bytes = render_labels_pdf_batch(
        [label_data_from_unit(u) for u in ordered_units],
        fields=template.fields,
        width_mm=template.width_mm,
        height_mm=template.height_mm,
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": 'inline; filename="labels-batch.pdf"'},
    )


def _rack_label_data_for_cells(rack: Rack, warehouse_name: str, payload: RackLabelBatchRequest) -> list[RackLabelData]:
    rack_type_label = RACK_TYPE_LABELS.get(rack.type.value, rack.type.value)
    return [
        RackLabelData(
            location_code=cell.location_code,
            warehouse_name=warehouse_name,
            rack_type_label=rack_type_label,
            shelf=cell.shelf,
            cell=cell.cell,
        )
        for cell in payload.cells
    ]


@router.post("/racks/{rack_id}/labels/batch", dependencies=[Depends(get_current_user)])
def get_rack_labels_batch(rack_id: int, payload: RackLabelBatchRequest, db: Session = Depends(get_db)) -> Response:
    """Печать этикеток мест хранения (раздел про макеты для стеллажей/
    полок) — один PDF на все переданные ячейки/полки стеллажа, тот же
    приём "очередь печати", что уже есть для партии единиц при приёмке.
    Одиночная печать (перепечатать одну повреждённую бирку) — тот же
    эндпоинт с cells из одного элемента, отдельного не заводим."""
    rack = db.get(Rack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    warehouse = db.get(Warehouse, rack.warehouse_id)
    template = _get_template(db, "rack")
    pdf_bytes = render_rack_labels_pdf_batch(
        _rack_label_data_for_cells(rack, warehouse.name if warehouse else "—", payload),
        fields=template.fields,
        width_mm=template.width_mm,
        height_mm=template.height_mm,
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="rack-labels-{rack.code}.pdf"'},
    )


@router.post("/racks/{rack_id}/labels/batch/html", dependencies=[Depends(get_current_user)])
def get_rack_labels_batch_html(rack_id: int, payload: RackLabelBatchRequest, db: Session = Depends(get_db)) -> Response:
    rack = db.get(Rack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    warehouse = db.get(Warehouse, rack.warehouse_id)
    template = _get_template(db, "rack")
    html = render_rack_labels_html_batch(
        _rack_label_data_for_cells(rack, warehouse.name if warehouse else "—", payload),
        fields=template.fields,
        width_mm=template.width_mm,
        height_mm=template.height_mm,
    )
    return Response(content=html, media_type="text/html")
