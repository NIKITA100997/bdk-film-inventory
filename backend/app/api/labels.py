from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.labels import LabelTemplate
from app.models.units import MaterialUnit
from app.schemas.labels import AvailableFieldOut, LabelBatchRequest, LabelTemplateOut, LabelTemplateUpdate
from app.services.labels import (
    DEFAULT_FIELDS,
    DEFAULT_HEIGHT_MM,
    DEFAULT_WIDTH_MM,
    FIELD_META,
    PREVIEW_DATA,
    label_data_from_unit,
    render_label_html,
    render_label_pdf,
    render_labels_html_batch,
    render_labels_pdf_batch,
)

router = APIRouter(tags=["labels"])

# Часть администрирования (5.6 ТЗ) — доступ только логисту/руководителю.
manage_labels = require_permission("labels.manage")


def _get_template(db: Session) -> LabelTemplate:
    template = db.get(LabelTemplate, 1)
    if template is None:
        template = LabelTemplate(id=1, width_mm=DEFAULT_WIDTH_MM, height_mm=DEFAULT_HEIGHT_MM, fields=DEFAULT_FIELDS)
        db.add(template)
        db.commit()
        db.refresh(template)
    elif template.width_mm == 60 and template.height_mm == 90:
        template.width_mm = 100
        template.height_mm = 40
        db.commit()
        db.refresh(template)
    return template


@router.get("/label-template", response_model=LabelTemplateOut)
def get_label_template(db: Session = Depends(get_db), user=Depends(get_current_user)) -> LabelTemplate:
    return _get_template(db)


@router.get("/label-template/available-fields", response_model=list[AvailableFieldOut])
def list_available_fields(user=Depends(get_current_user)) -> list[AvailableFieldOut]:
    return [AvailableFieldOut(key=key, **meta) for key, meta in FIELD_META.items()]


@router.patch("/label-template", response_model=LabelTemplateOut)
def update_label_template(
    payload: LabelTemplateUpdate, db: Session = Depends(get_db), user=Depends(manage_labels)
) -> LabelTemplate:
    template = _get_template(db)
    template.width_mm = payload.width_mm
    template.height_mm = payload.height_mm
    template.fields = [f.model_dump() for f in payload.fields]
    db.commit()
    db.refresh(template)
    return template


@router.post("/label-template/preview")
def preview_label_template(payload: LabelTemplateUpdate, user=Depends(manage_labels)) -> Response:
    """Превью макета на синтетических данных (4 раздел бэклога доработок) —
    не требует реальной единицы и не сохраняет изменения.

    Отдаёт настоящий PDF, не HTML-страницу (по итогам полевого тестирования
    печати на термопринтере Codex G500 — прямая печать HTML из браузера
    оказалась ненадёжной, тот же путь, что у "Сохранить как PDF", уже
    подтверждён рабочим). Превью показывает ровно то, что реально уйдёт на
    печать, без расхождений между просмотром и печатью."""
    pdf_bytes = render_label_pdf(
        PREVIEW_DATA,
        fields=[f.model_dump() for f in payload.fields],
        width_mm=payload.width_mm,
        height_mm=payload.height_mm,
    )
    return Response(content=pdf_bytes, media_type="application/pdf")


@router.get("/labels/{unit_id}", dependencies=[Depends(get_current_user)])
def get_label(unit_id: int, db: Session = Depends(get_db)) -> Response:
    unit = db.get(MaterialUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")
    template = _get_template(db)
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
    template = _get_template(db)
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
    template = _get_template(db)
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
    template = _get_template(db)
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
