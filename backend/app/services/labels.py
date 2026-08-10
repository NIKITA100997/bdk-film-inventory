"""Макет этикетки — не жёсткий HTML-шаблон, а структура (список полей +
порядок + опции отображения), которую render_label_html интерпретирует
(4 раздел бэклога доработок). LabelData — плоский снимок нужных для печати
данных, чтобы render_field_value была чистой функцией без ORM/БД —
тестируется напрямую, а превью макета может использовать синтетические
данные без реальной единицы в базе."""

import base64
from dataclasses import dataclass
from datetime import date
from io import BytesIO

import qrcode

from app.models.units import MaterialUnit

# Палитра — из презентации БДК (БДК_Презентация_v3_учет_пленок.pptx):
# зелёный/тёмно-синий вместо исходных зелёного/синего, чтобы не вводить
# отдельный акцентный цвет, которого нет в общей дизайн-системе приложения.
NAVY = "#2C2E3A"
GRAY = "#6B6B68"
BORDER = "#DEDEDA"
GREEN = "#1D9E75"

SIZE_PT = {"sm": 8, "md": 10, "lg": 16}

DEFAULT_WIDTH_MM = 60
DEFAULT_HEIGHT_MM = 90

# Плейсхолдер для нового макета — тот же порядок/состав полей, что и в
# исходном хардкоженном шаблоне, чтобы обновление ничего не сломало.
DEFAULT_FIELDS: list[dict] = [
    {"key": "qr", "size": "md", "bold": False},
    {"key": "unit_id", "size": "lg", "bold": True},
    {"key": "material", "size": "md", "bold": True},
    {"key": "color", "size": "md", "bold": True},
    {"key": "thickness", "size": "md", "bold": True},
    {"key": "manufacturer", "size": "md", "bold": True},
    {"key": "status_stripe", "size": "sm", "bold": False},
    {"key": "upd_number", "size": "sm", "bold": False},
    {"key": "pallet_number", "size": "sm", "bold": False},
    {"key": "received_date", "size": "sm", "bold": False},
    {"key": "parent_ref", "size": "sm", "bold": False},
]

# Раздел 4.1 ТЗ: ширина/длина принципиально не печатаются по умолчанию — их
# отсутствие на бирке даёт всю экономию на переэтикетировании при
# разделении. Доступны в конструкторе, но помечены как "устаревающие".
FIELD_META: dict[str, dict] = {
    "qr": {"label": "QR-код", "kind": "image"},
    "unit_id": {"label": "№ единицы", "kind": "text"},
    "material": {"label": "Материал", "kind": "text"},
    "color": {"label": "Цвет", "kind": "text"},
    "thickness": {"label": "Толщина", "kind": "text"},
    "manufacturer": {"label": "Производитель", "kind": "text"},
    "status_stripe": {"label": "Цветная полоса (статус)", "kind": "stripe"},
    "upd_number": {"label": "№ УПД", "kind": "text"},
    "pallet_number": {"label": "№ паллеты", "kind": "text"},
    "received_date": {"label": "Дата приёмки", "kind": "text"},
    "supplier_code": {"label": "Код у поставщика", "kind": "text"},
    "native_width": {"label": "Родная ширина рулона, мм", "kind": "text"},
    "parent_ref": {"label": "Из рулона №…", "kind": "text"},
    "width_mm": {"label": "Ширина (текущая), мм", "kind": "text", "stale_warning": True},
    "length_m": {"label": "Длина (текущая), м", "kind": "text", "stale_warning": True},
}


@dataclass(frozen=True)
class LabelData:
    unit_id: int
    material: str
    color: str
    thickness_mm: float
    manufacturer: str
    upd_number: str
    pallet_number: str
    received_date: date | None
    supplier_code: str | None
    native_width_mm: float | None
    parent_id: int | None
    width_mm: float
    length_m: float


def label_data_from_unit(unit: MaterialUnit) -> LabelData:
    sku = unit.material_sku
    return LabelData(
        unit_id=unit.id,
        material=sku.material.name,
        color=sku.color.name,
        thickness_mm=float(sku.thickness.value_mm),
        manufacturer=sku.manufacturer.name,
        upd_number=unit.upd_number,
        pallet_number=unit.pallet_number,
        received_date=unit.created_at.date() if unit.created_at else None,
        supplier_code=sku.supplier_code,
        native_width_mm=float(sku.native_width_mm) if sku.native_width_mm is not None else None,
        parent_id=unit.parent_id,
        width_mm=float(unit.width_mm),
        length_m=float(unit.length_m),
    )


def indicator_color(data: LabelData) -> str:
    """Цветная полоса-индикатор (раздел 4.1 ТЗ): целый рулон/штрипс
    определяем по наличию parent_id. Пока без ABC-анализа "свободный
    остаток" (серый) не различаем."""
    return GREEN if data.parent_id is None else NAVY


def render_field_value(data: LabelData, key: str) -> str | None:
    """None — поле нечего показывать (например, единица не резалась из
    родителя) — тогда строка в теле этикетки просто пропускается."""
    if key == "unit_id":
        return f"№ {data.unit_id}"
    if key == "material":
        return data.material
    if key == "color":
        return data.color
    if key == "thickness":
        return f"{data.thickness_mm} мм"
    if key == "manufacturer":
        return data.manufacturer
    if key == "upd_number":
        return f"УПД {data.upd_number}"
    if key == "pallet_number":
        return f"паллета {data.pallet_number}"
    if key == "received_date":
        return data.received_date.strftime("%d.%m.%Y") if data.received_date else ""
    if key == "supplier_code":
        return data.supplier_code or ""
    if key == "native_width":
        return f"{data.native_width_mm} мм" if data.native_width_mm is not None else ""
    if key == "parent_ref":
        return f"Из рулона №{data.parent_id}" if data.parent_id else None
    if key == "width_mm":
        return f"{data.width_mm} мм"
    if key == "length_m":
        return f"{data.length_m} м"
    return None


def qr_data_uri(payload: str) -> str:
    img = qrcode.make(payload, border=1)
    buf = BytesIO()
    img.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def render_label_html(
    data: LabelData,
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_WIDTH_MM,
    height_mm: int = DEFAULT_HEIGHT_MM,
) -> str:
    fields = fields if fields is not None else DEFAULT_FIELDS
    color = indicator_color(data)
    qr_src = qr_data_uri(str(data.unit_id))

    body_parts: list[str] = []
    has_stripe = False
    for f in fields:
        key = f["key"]
        if key == "status_stripe":
            has_stripe = True
        elif key == "qr":
            body_parts.append(
                f'<div class="qr-frame"><img class="qr" src="{qr_src}" alt="QR {data.unit_id}"></div>'
            )
        else:
            value = render_field_value(data, key)
            if not value:
                continue
            size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
            weight = "bold" if f.get("bold") else "normal"
            css_class = "id" if key == "unit_id" else ""
            body_parts.append(
                f'<div class="{css_class}" style="font-size:{size_pt}pt;font-weight:{weight};">{value}</div>'
            )

    stripe_html = f'<div class="bar" style="background:{color}"></div>' if has_stripe else ""
    label_width_mm = max(width_mm - 6, 20)

    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетка №{data.unit_id}</title>
<style>
  @page {{ size: {width_mm}mm {height_mm}mm; margin: 3mm; }}
  body {{ font-family: "Calibri", "Segoe UI", Arial, sans-serif; margin: 0; color: {NAVY}; }}
  .label {{ width: {label_width_mm}mm; text-align: center; border: 1px solid {BORDER}; border-radius: 10px; overflow: hidden; }}
  .bar {{ height: 6mm; }}
  .body {{ padding: 3mm; }}
  .qr-frame {{ width: 34mm; height: 34mm; margin: 0 auto; background: #F5F5F4; border-radius: 6px; display: flex; align-items: center; justify-content: center; }}
  .qr {{ width: 30mm; height: 30mm; }}
  .id {{ font-family: "Cambria", Georgia, serif; margin: 2mm 0; }}
  .body > div {{ line-height: 1.3; }}
  @media print {{ .no-print {{ display: none; }} }}
</style>
</head>
<body>
  <div class="label">
    {stripe_html}
    <div class="body">
      {"".join(body_parts)}
    </div>
  </div>
  <div class="no-print">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


PREVIEW_DATA = LabelData(
    unit_id=12345,
    material="ПВХ плёнка",
    color="Дуб беленый",
    thickness_mm=0.35,
    manufacturer="Классен",
    upd_number="УПД-000123",
    pallet_number="4",
    received_date=date.today(),
    supplier_code="KL-3391",
    native_width_mm=1400,
    parent_id=None,
    width_mm=1400,
    length_m=214,
)
