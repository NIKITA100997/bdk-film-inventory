from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.dictionaries import Color, Manufacturer, Material, Thickness
from app.models.labels import LabelTemplate
from app.models.storage import MacroZoneRule, Rack, RackType, Warehouse
from app.models.units import MaterialUnit
from app.schemas.labels import AvailableFieldOut, LabelBatchRequest, LabelTemplateOut, LabelTemplateUpdate, ShelfLabelBatchRequest
from app.services.labels import (
    DEFAULT_FIELDS,
    DEFAULT_FIELDS_CUTTING_ISSUE,
    DEFAULT_FIELDS_RACK,
    DEFAULT_FIELDS_SHELF,
    DEFAULT_HEIGHT_MM,
    DEFAULT_RACK_HEIGHT_MM,
    DEFAULT_RACK_WIDTH_MM,
    DEFAULT_SHELF_HEIGHT_MM,
    DEFAULT_SHELF_WIDTH_MM,
    DEFAULT_WIDTH_MM,
    FIELD_META,
    FIELD_META_RACK,
    FIELD_META_SHELF,
    PREVIEW_DATA,
    PREVIEW_DATA_RACK,
    PREVIEW_DATA_SHELF,
    PREVIEW_DATA_STRIP,
    RACK_TYPE_LABELS,
    RackLabelData,
    ShelfLabelData,
    label_data_from_unit,
    render_label_html,
    render_label_pdf,
    render_labels_html_batch,
    render_labels_pdf_batch,
    render_rack_label_html,
    render_rack_label_pdf,
    render_shelf_label_pdf,
    render_shelf_labels_html_batch,
    render_shelf_labels_pdf_batch,
)

router = APIRouter(tags=["labels"])

# Часть администрирования (5.6 ТЗ) — доступ только логисту/руководителю.
manage_labels = require_permission("labels.manage")

# Раздел про отдельные макеты для штрипсов/рулонов/стеллажей и для этапа
# резки/выдачи: "roll"/"strip" — единица плёнки (тот же рендер/данные
# LabelData, что раньше был один общий "unit"), "rack_roll"/"rack_strip" —
# стеллаж целиком (был один общий "rack"), "cutting_issue" — печать сразу
# после резки/выдачи участку (раньше — временная дописка поля "Назначение"
# поверх макета "unit" через extra_fields, теперь полноценный вид со своим
# сохраняемым макетом). Прежние ключи "unit"/"rack" переименованы в БД
# миграцией 7393d0901c8c.
_KIND_DEFAULTS = {
    "roll": (DEFAULT_WIDTH_MM, DEFAULT_HEIGHT_MM, DEFAULT_FIELDS),
    "strip": (DEFAULT_WIDTH_MM, DEFAULT_HEIGHT_MM, DEFAULT_FIELDS),
    "cutting_issue": (DEFAULT_WIDTH_MM, DEFAULT_HEIGHT_MM, DEFAULT_FIELDS_CUTTING_ISSUE),
    "rack_roll": (DEFAULT_RACK_WIDTH_MM, DEFAULT_RACK_HEIGHT_MM, DEFAULT_FIELDS_RACK),
    "rack_strip": (DEFAULT_RACK_WIDTH_MM, DEFAULT_RACK_HEIGHT_MM, DEFAULT_FIELDS_RACK),
    "shelf": (DEFAULT_SHELF_WIDTH_MM, DEFAULT_SHELF_HEIGHT_MM, DEFAULT_FIELDS_SHELF),
}

_UNIT_LABEL_KINDS = ("roll", "strip", "cutting_issue")
_RACK_LABEL_KINDS = ("rack_roll", "rack_strip")


def _unit_label_kind(unit: MaterialUnit) -> str:
    return "strip" if unit.is_strip else "roll"


def _content_disposition(filename: str) -> str:
    """HTTP-заголовки — только latin-1 (RFC 7230), а код стеллажа обычно
    кириллица ("Р-3") — голая f-строка с ним в filename роняла ответ
    UnicodeEncodeError на этапе формирования заголовков. filename* (RFC
    6266, percent-encoded UTF-8) — стандартный способ передать не-ASCII
    имя файла, filename — ASCII-заглушка для совсем старых клиентов."""
    ascii_fallback = filename.encode("ascii", "replace").decode("ascii")
    return f"inline; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(filename)}"


def _oriented(template: LabelTemplate, vertical: bool) -> tuple[int, int]:
    """Печать той же этикетки в вертикальном виде (раздел про ориентацию
    печати) — размеры макета не меняются, просто ширина и высота
    меняются местами перед отрисовкой: остальной код макета уже сам
    решает раскладку (QR сбоку от текста или над ним) по тому, что больше
    — ширина или высота, так что перестановка местами даёт корректный
    повёрнутый макет без отдельной ветки вёрстки."""
    return (template.height_mm, template.width_mm) if vertical else (template.width_mm, template.height_mm)


def _get_template(db: Session, kind: str) -> LabelTemplate:
    template = db.query(LabelTemplate).filter(LabelTemplate.kind == kind).first()
    if template is None:
        width_mm, height_mm, fields = _KIND_DEFAULTS.get(kind, _KIND_DEFAULTS["shelf"])
        template = LabelTemplate(kind=kind, width_mm=width_mm, height_mm=height_mm, fields=fields)
        db.add(template)
        db.commit()
        db.refresh(template)
    elif kind == "roll" and template.width_mm == 60 and template.height_mm == 90:
        # Раньше единственный singleton-макет (id=1) мог остаться со старым
        # дефолтом 60×90 — актуально только для рулонов, у остальных
        # макетов такой истории нет.
        template.width_mm = 100
        template.height_mm = 40
        db.commit()
        db.refresh(template)
    return template


@router.get("/label-template", response_model=LabelTemplateOut)
def get_label_template(kind: str = "roll", db: Session = Depends(get_db), user=Depends(get_current_user)) -> LabelTemplate:
    return _get_template(db, kind)


@router.get("/label-template/available-fields", response_model=list[AvailableFieldOut])
def list_available_fields(kind: str = "roll", user=Depends(get_current_user)) -> list[AvailableFieldOut]:
    if kind in _UNIT_LABEL_KINDS:
        meta = FIELD_META
    elif kind in _RACK_LABEL_KINDS:
        meta = FIELD_META_RACK
    else:
        meta = FIELD_META_SHELF
    return [AvailableFieldOut(key=key, **m) for key, m in meta.items()]


@router.patch("/label-template", response_model=LabelTemplateOut)
def update_label_template(
    payload: LabelTemplateUpdate, kind: str = "roll", db: Session = Depends(get_db), user=Depends(manage_labels)
) -> LabelTemplate:
    template = _get_template(db, kind)
    template.width_mm = payload.width_mm
    template.height_mm = payload.height_mm
    template.fields = [f.model_dump() for f in payload.fields]
    db.commit()
    db.refresh(template)
    return template


@router.post("/label-template/preview")
def preview_label_template(payload: LabelTemplateUpdate, kind: str = "roll", user=Depends(manage_labels)) -> Response:
    """Превью макета на синтетических данных (4 раздел бэклога доработок) —
    не требует реальной единицы/стеллажа и не сохраняет изменения.

    Отдаёт настоящий PDF, не HTML-страницу (по итогам полевого тестирования
    печати на термопринтере Codex G500 — прямая печать HTML из браузера
    оказалась ненадёжной, тот же путь, что у "Сохранить как PDF", уже
    подтверждён рабочим). Превью показывает ровно то, что реально уйдёт на
    печать, без расхождений между просмотром и печатью."""
    fields = [f.model_dump() for f in payload.fields]
    if kind == "strip":
        pdf_bytes = render_label_pdf(PREVIEW_DATA_STRIP, fields=fields, width_mm=payload.width_mm, height_mm=payload.height_mm)
    elif kind in _UNIT_LABEL_KINDS:
        pdf_bytes = render_label_pdf(PREVIEW_DATA, fields=fields, width_mm=payload.width_mm, height_mm=payload.height_mm)
    elif kind in _RACK_LABEL_KINDS:
        pdf_bytes = render_rack_label_pdf(PREVIEW_DATA_RACK, fields=fields, width_mm=payload.width_mm, height_mm=payload.height_mm)
    else:
        pdf_bytes = render_shelf_label_pdf(PREVIEW_DATA_SHELF, fields=fields, width_mm=payload.width_mm, height_mm=payload.height_mm)
    return Response(content=pdf_bytes, media_type="application/pdf")


@router.get("/labels/{unit_id}", dependencies=[Depends(get_current_user)])
def get_label(unit_id: int, vertical: bool = False, kind: str | None = None, db: Session = Depends(get_db)) -> Response:
    unit = db.get(MaterialUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")
    template = _get_template(db, kind or _unit_label_kind(unit))
    width_mm, height_mm = _oriented(template, vertical)
    pdf_bytes = render_label_pdf(label_data_from_unit(unit), fields=template.fields, width_mm=width_mm, height_mm=height_mm)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(f"label-{unit_id}.pdf")},
    )


@router.get("/labels/{unit_id}/html", dependencies=[Depends(get_current_user)])
def get_label_html(
    unit_id: int, vertical: bool = False, kind: str | None = None, db: Session = Depends(get_db)
) -> Response:
    """HTML-версия той же этикетки (планшеты — печать PDF-blob через
    window.print() на части Android-браузеров не срабатывает, система
    перехватывает blob как файл на скачивание вместо печати; обычная
    HTML-страница печатается штатным Print Service Framework Android)."""
    unit = db.get(MaterialUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")
    template = _get_template(db, kind or _unit_label_kind(unit))
    width_mm, height_mm = _oriented(template, vertical)
    html = render_label_html(label_data_from_unit(unit), fields=template.fields, width_mm=width_mm, height_mm=height_mm)
    return Response(content=html, media_type="text/html")


@router.post("/labels/batch/html", dependencies=[Depends(get_current_user)])
def get_labels_batch_html(
    payload: LabelBatchRequest, vertical: bool = False, kind: str | None = None, db: Session = Depends(get_db)
) -> Response:
    units = db.query(MaterialUnit).filter(MaterialUnit.id.in_(payload.unit_ids)).all()
    units_by_id = {u.id: u for u in units}
    ordered_units = [units_by_id[uid] for uid in payload.unit_ids if uid in units_by_id]
    if not ordered_units:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ни одна из единиц не найдена")
    # Без явного kind — берём вид по первой единице партии (раздел про
    # отдельные макеты рулон/штрипс): у одного макета в пачке одна ширина/
    # высота страницы, разнородную по типу партию так корректно не
    # напечатать — на практике пачка почти всегда однородна (одна сессия
    # приёмки/пересчёта одного и того же материала).
    template = _get_template(db, kind or _unit_label_kind(ordered_units[0]))
    width_mm, height_mm = _oriented(template, vertical)
    html = render_labels_html_batch(
        [label_data_from_unit(u) for u in ordered_units], fields=template.fields, width_mm=width_mm, height_mm=height_mm
    )
    return Response(content=html, media_type="text/html")


@router.post("/labels/batch", dependencies=[Depends(get_current_user)])
def get_labels_batch(
    payload: LabelBatchRequest, vertical: bool = False, kind: str | None = None, db: Session = Depends(get_db)
) -> Response:
    """Очередь печати (раздел про ускорение работы): один PDF на несколько
    единиц вместо открытия отдельной вкладки/запроса на каждую — актуально
    после сессии приёмки на партию из N рулонов."""
    units = db.query(MaterialUnit).filter(MaterialUnit.id.in_(payload.unit_ids)).all()
    units_by_id = {u.id: u for u in units}
    ordered_units = [units_by_id[uid] for uid in payload.unit_ids if uid in units_by_id]
    if not ordered_units:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ни одна из единиц не найдена")
    template = _get_template(db, kind or _unit_label_kind(ordered_units[0]))
    width_mm, height_mm = _oriented(template, vertical)
    pdf_bytes = render_labels_pdf_batch(
        [label_data_from_unit(u) for u in ordered_units], fields=template.fields, width_mm=width_mm, height_mm=height_mm
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition("labels-batch.pdf")},
    )


def _rule_text(db: Session, rule: MacroZoneRule, *, with_range: bool) -> str:
    """Тот же текст, что уже показывает пользователю StorageMap.tsx для
    правил зонирования (materialName/colorName/thicknessName/
    manufacturerName + шапка "Полки {from}–{to}") — здесь строится тот же
    текст, но на бэкенде, для печати на бирке."""
    material = db.get(Material, rule.material_id).name if rule.material_id else "любой"
    color = db.get(Color, rule.color_id).name if rule.color_id else "любой"
    thickness = f"{db.get(Thickness, rule.thickness_id).value_mm} мм" if rule.thickness_id else "любая"
    manufacturer = db.get(Manufacturer, rule.manufacturer_id).name if rule.manufacturer_id else "любой"
    body = f"{material}, {color}, {thickness}, {manufacturer}"
    return f"Полки {rule.from_shelf}–{rule.to_shelf}: {body}" if with_range else body


def _rules_for_rack(db: Session, rack_id: int) -> list[MacroZoneRule]:
    return db.query(MacroZoneRule).filter(MacroZoneRule.rack_id == rack_id).order_by(MacroZoneRule.from_shelf).all()


def _rack_storage_rules_text(db: Session, rules: list[MacroZoneRule]) -> str | None:
    if not rules:
        return None
    return "; ".join(_rule_text(db, r, with_range=True) for r in rules)


def _shelf_storage_rules_text(db: Session, rules: list[MacroZoneRule], shelf: int) -> str | None:
    matching = [r for r in rules if r.from_shelf <= shelf <= r.to_shelf]
    if not matching:
        return None
    return "; ".join(_rule_text(db, r, with_range=False) for r in matching)


def _shelf_label_data_for_cells(db: Session, rack: Rack, warehouse_name: str, payload: ShelfLabelBatchRequest) -> list[ShelfLabelData]:
    rack_type_label = RACK_TYPE_LABELS.get(rack.type.value, rack.type.value)
    rules = _rules_for_rack(db, rack.id)
    return [
        ShelfLabelData(
            location_code=cell.location_code,
            warehouse_name=warehouse_name,
            rack_type_label=rack_type_label,
            shelf=cell.shelf,
            storage_rules_text=_shelf_storage_rules_text(db, rules, cell.shelf),
        )
        for cell in payload.cells
    ]


def _rack_label_kind(rack: Rack) -> str:
    return "rack_strip" if rack.type == RackType.STRIP else "rack_roll"


@router.post("/racks/{rack_id}/rack-label", dependencies=[Depends(get_current_user)])
def get_rack_label(rack_id: int, vertical: bool = False, db: Session = Depends(get_db)) -> Response:
    """Бирка на весь стеллаж целиком (не на отдельное место хранения —
    те см. /racks/{rack_id}/shelf-labels/batch)."""
    rack = db.get(Rack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    warehouse = db.get(Warehouse, rack.warehouse_id)
    template = _get_template(db, _rack_label_kind(rack))
    width_mm, height_mm = _oriented(template, vertical)
    data = RackLabelData(
        rack_code=rack.code,
        warehouse_name=warehouse.name if warehouse else "—",
        rack_type_label=RACK_TYPE_LABELS.get(rack.type.value, rack.type.value),
        shelf_count=rack.shelf_count,
        storage_rules_text=_rack_storage_rules_text(db, _rules_for_rack(db, rack.id)),
    )
    pdf_bytes = render_rack_label_pdf(data, fields=template.fields, width_mm=width_mm, height_mm=height_mm)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(f"rack-label-{rack.code}.pdf")},
    )


@router.post("/racks/{rack_id}/rack-label/html", dependencies=[Depends(get_current_user)])
def get_rack_label_html(rack_id: int, vertical: bool = False, db: Session = Depends(get_db)) -> Response:
    rack = db.get(Rack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    warehouse = db.get(Warehouse, rack.warehouse_id)
    template = _get_template(db, _rack_label_kind(rack))
    width_mm, height_mm = _oriented(template, vertical)
    data = RackLabelData(
        rack_code=rack.code,
        warehouse_name=warehouse.name if warehouse else "—",
        rack_type_label=RACK_TYPE_LABELS.get(rack.type.value, rack.type.value),
        shelf_count=rack.shelf_count,
        storage_rules_text=_rack_storage_rules_text(db, _rules_for_rack(db, rack.id)),
    )
    html = render_rack_label_html(data, fields=template.fields, width_mm=width_mm, height_mm=height_mm)
    return Response(content=html, media_type="text/html")


@router.post("/racks/{rack_id}/shelf-labels/batch", dependencies=[Depends(get_current_user)])
def get_shelf_labels_batch(
    rack_id: int, payload: ShelfLabelBatchRequest, vertical: bool = False, db: Session = Depends(get_db)
) -> Response:
    """Печать этикеток мест хранения (раздел про макеты для стеллажей/
    полок) — один PDF на все переданные ячейки/полки стеллажа, тот же
    приём "очередь печати", что уже есть для партии единиц при приёмке.
    Одиночная печать (перепечатать одну повреждённую бирку) — тот же
    эндпоинт с cells из одного элемента, отдельного не заводим."""
    rack = db.get(Rack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    warehouse = db.get(Warehouse, rack.warehouse_id)
    template = _get_template(db, "shelf")
    width_mm, height_mm = _oriented(template, vertical)
    pdf_bytes = render_shelf_labels_pdf_batch(
        _shelf_label_data_for_cells(db, rack, warehouse.name if warehouse else "—", payload),
        fields=template.fields,
        width_mm=width_mm,
        height_mm=height_mm,
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(f"shelf-labels-{rack.code}.pdf")},
    )


@router.post("/racks/{rack_id}/shelf-labels/batch/html", dependencies=[Depends(get_current_user)])
def get_shelf_labels_batch_html(
    rack_id: int, payload: ShelfLabelBatchRequest, vertical: bool = False, db: Session = Depends(get_db)
) -> Response:
    rack = db.get(Rack, rack_id)
    if rack is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Стеллаж не найден")
    warehouse = db.get(Warehouse, rack.warehouse_id)
    template = _get_template(db, "shelf")
    width_mm, height_mm = _oriented(template, vertical)
    html = render_shelf_labels_html_batch(
        _shelf_label_data_for_cells(db, rack, warehouse.name if warehouse else "—", payload),
        fields=template.fields,
        width_mm=width_mm,
        height_mm=height_mm,
    )
    return Response(content=html, media_type="text/html")
