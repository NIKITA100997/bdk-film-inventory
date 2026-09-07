from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.api.labels import _get_template
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.part_storage import PartRack
from app.models.part_units import PartUnit
from app.schemas.labels import PartLabelBatchRequest, ShelfLabelBatchRequest
from app.services.labels import (
    PageFormat,
    PartRackLabelData,
    PartShelfLabelData,
    part_label_data_from_unit,
    render_pf_rack_label_html,
    render_pf_rack_label_pdf,
    render_pf_shelf_label_html,
    render_pf_shelf_labels_html_batch,
    render_pf_shelf_labels_pdf_batch,
    render_pf_unit_label_html,
    render_pf_unit_label_pdf,
    render_pf_unit_labels_html_batch,
    render_pf_unit_labels_pdf_batch,
    resolve_page_format_dims,
)

router = APIRouter(tags=["part-labels"])

# Раздел про QR-этикетки п/ф — печать не считается привилегированным
# действием (тот же принцип, что у этикеток плёнки в labels.py: доступ к
# самим данным уже гейтится на уровне списка партий/стеллажей отдельными
# правами part_units.*/part_storage.manage).


def _content_disposition(filename: str) -> str:
    ascii_fallback = filename.encode("ascii", "replace").decode("ascii")
    return f"inline; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(filename)}"


@router.get("/part-labels/{unit_id}", dependencies=[Depends(get_current_user)])
def get_part_label(
    unit_id: int, vertical: bool = False, page_format: PageFormat = "sticker", db: Session = Depends(get_db)
) -> Response:
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Партия не найдена")
    template = _get_template(db, "pf_unit")
    width_mm, height_mm = resolve_page_format_dims(template.width_mm, template.height_mm, page_format)
    pdf_bytes = render_pf_unit_label_pdf(
        part_label_data_from_unit(unit, db), fields=template.fields, width_mm=width_mm, height_mm=height_mm,
        vertical=vertical, page_format=page_format,
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(f"part-label-{unit_id}.pdf")},
    )


@router.get("/part-labels/{unit_id}/html", dependencies=[Depends(get_current_user)])
def get_part_label_html(
    unit_id: int, vertical: bool = False, page_format: PageFormat = "sticker", db: Session = Depends(get_db)
) -> Response:
    unit = db.get(PartUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Партия не найдена")
    template = _get_template(db, "pf_unit")
    width_mm, height_mm = resolve_page_format_dims(template.width_mm, template.height_mm, page_format)
    html = render_pf_unit_label_html(
        part_label_data_from_unit(unit, db), fields=template.fields, width_mm=width_mm, height_mm=height_mm,
        vertical=vertical, page_format=page_format,
    )
    return Response(content=html, media_type="text/html")


@router.post("/part-labels/batch", dependencies=[Depends(get_current_user)])
def get_part_labels_batch(
    payload: PartLabelBatchRequest, vertical: bool = False, page_format: PageFormat = "sticker", db: Session = Depends(get_db)
) -> Response:
    units = db.query(PartUnit).filter(PartUnit.id.in_(payload.unit_ids)).all()
    units_by_id = {u.id: u for u in units}
    ordered_units = [units_by_id[uid] for uid in payload.unit_ids if uid in units_by_id]
    if not ordered_units:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ни одна из партий не найдена")
    template = _get_template(db, "pf_unit")
    width_mm, height_mm = resolve_page_format_dims(template.width_mm, template.height_mm, page_format)
    pdf_bytes = render_pf_unit_labels_pdf_batch(
        [part_label_data_from_unit(u, db) for u in ordered_units],
        fields=template.fields, width_mm=width_mm, height_mm=height_mm, vertical=vertical, page_format=page_format,
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition("part-labels-batch.pdf")},
    )


@router.post("/part-labels/batch/html", dependencies=[Depends(get_current_user)])
def get_part_labels_batch_html(
    payload: PartLabelBatchRequest, vertical: bool = False, page_format: PageFormat = "sticker", db: Session = Depends(get_db)
) -> Response:
    units = db.query(PartUnit).filter(PartUnit.id.in_(payload.unit_ids)).all()
    units_by_id = {u.id: u for u in units}
    ordered_units = [units_by_id[uid] for uid in payload.unit_ids if uid in units_by_id]
    if not ordered_units:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ни одна из партий не найдена")
    template = _get_template(db, "pf_unit")
    width_mm, height_mm = resolve_page_format_dims(template.width_mm, template.height_mm, page_format)
    html = render_pf_unit_labels_html_batch(
        [part_label_data_from_unit(u, db) for u in ordered_units],
        fields=template.fields, width_mm=width_mm, height_mm=height_mm, vertical=vertical, page_format=page_format,
    )
    return Response(content=html, media_type="text/html")


@router.post("/part-racks/{rack_id}/rack-label", dependencies=[Depends(get_current_user)])
def get_part_rack_label(
    rack_id: int, vertical: bool = False, page_format: PageFormat = "sticker", db: Session = Depends(get_db)
) -> Response:
    rack = db.get(PartRack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    template = _get_template(db, "pf_rack")
    width_mm, height_mm = resolve_page_format_dims(template.width_mm, template.height_mm, page_format)
    data = PartRackLabelData(rack_code=rack.code, shelf_count=rack.shelf_count)
    pdf_bytes = render_pf_rack_label_pdf(
        data, fields=template.fields, width_mm=width_mm, height_mm=height_mm, vertical=vertical, page_format=page_format
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(f"part-rack-label-{rack.code}.pdf")},
    )


@router.post("/part-racks/{rack_id}/rack-label/html", dependencies=[Depends(get_current_user)])
def get_part_rack_label_html(
    rack_id: int, vertical: bool = False, page_format: PageFormat = "sticker", db: Session = Depends(get_db)
) -> Response:
    rack = db.get(PartRack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    template = _get_template(db, "pf_rack")
    width_mm, height_mm = resolve_page_format_dims(template.width_mm, template.height_mm, page_format)
    data = PartRackLabelData(rack_code=rack.code, shelf_count=rack.shelf_count)
    html = render_pf_rack_label_html(
        data, fields=template.fields, width_mm=width_mm, height_mm=height_mm, vertical=vertical, page_format=page_format
    )
    return Response(content=html, media_type="text/html")


@router.post("/part-racks/{rack_id}/shelf-labels/batch", dependencies=[Depends(get_current_user)])
def get_part_shelf_labels_batch(
    rack_id: int, payload: ShelfLabelBatchRequest, vertical: bool = False, page_format: PageFormat = "sticker",
    db: Session = Depends(get_db),
) -> Response:
    rack = db.get(PartRack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    template = _get_template(db, "pf_shelf")
    width_mm, height_mm = resolve_page_format_dims(template.width_mm, template.height_mm, page_format)
    items = [PartShelfLabelData(location_code=cell.location_code, rack_code=rack.code, shelf=cell.shelf) for cell in payload.cells]
    pdf_bytes = render_pf_shelf_labels_pdf_batch(
        items, fields=template.fields, width_mm=width_mm, height_mm=height_mm, vertical=vertical, page_format=page_format
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(f"part-shelf-labels-{rack.code}.pdf")},
    )


@router.post("/part-racks/{rack_id}/shelf-labels/batch/html", dependencies=[Depends(get_current_user)])
def get_part_shelf_labels_batch_html(
    rack_id: int, payload: ShelfLabelBatchRequest, vertical: bool = False, page_format: PageFormat = "sticker",
    db: Session = Depends(get_db),
) -> Response:
    rack = db.get(PartRack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    template = _get_template(db, "pf_shelf")
    width_mm, height_mm = resolve_page_format_dims(template.width_mm, template.height_mm, page_format)
    items = [PartShelfLabelData(location_code=cell.location_code, rack_code=rack.code, shelf=cell.shelf) for cell in payload.cells]
    html = render_pf_shelf_labels_html_batch(
        items, fields=template.fields, width_mm=width_mm, height_mm=height_mm, vertical=vertical, page_format=page_format
    )
    return Response(content=html, media_type="text/html")
