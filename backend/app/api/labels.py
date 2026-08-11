from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.labels import LabelTemplate
from app.models.units import MaterialUnit
from app.schemas.labels import AvailableFieldOut, LabelTemplateOut, LabelTemplateUpdate
from app.services.labels import (
    DEFAULT_FIELDS,
    DEFAULT_HEIGHT_MM,
    DEFAULT_WIDTH_MM,
    FIELD_META,
    PREVIEW_DATA,
    label_data_from_unit,
    render_label_html,
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


@router.post("/label-template/preview", response_class=HTMLResponse)
def preview_label_template(payload: LabelTemplateUpdate, user=Depends(manage_labels)) -> str:
    """Превью макета на синтетических данных (4 раздел бэклога доработок) —
    не требует реальной единицы и не сохраняет изменения."""
    return render_label_html(
        PREVIEW_DATA,
        fields=[f.model_dump() for f in payload.fields],
        width_mm=payload.width_mm,
        height_mm=payload.height_mm,
    )


@router.get("/labels/{unit_id}", response_class=HTMLResponse, dependencies=[Depends(get_current_user)])
def get_label(unit_id: int, db: Session = Depends(get_db)) -> str:
    unit = db.get(MaterialUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")
    template = _get_template(db)
    return render_label_html(
        label_data_from_unit(unit), fields=template.fields, width_mm=template.width_mm, height_mm=template.height_mm
    )
