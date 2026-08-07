import base64
from io import BytesIO

import qrcode

from app.models.units import MaterialUnit


def qr_data_uri(data: str) -> str:
    img = qrcode.make(data, border=1)
    buf = BytesIO()
    img.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


# Палитра — из презентации БДК (БДК_Презентация_v3_учет_пленок.pptx):
# зелёный/тёмно-синий вместо исходных зелёного/синего, чтобы не вводить
# отдельный акцентный цвет, которого нет в общей дизайн-системе приложения.
NAVY = "#2C2E3A"
GRAY = "#6B6B68"
BORDER = "#DEDEDA"
GREEN = "#1D9E75"


def indicator_color(unit: MaterialUnit) -> str:
    """Цветная полоса-индикатор на этикетке (раздел 4.1 ТЗ): статус на
    момент печати, не переопределяется позже. Пока без ABC-анализа (этап 7)
    "свободный остаток" (серый) не различаем — целый рулон/штрипс определяем
    по наличию parent_id."""
    return GREEN if unit.parent_id is None else NAVY  # целый рулон / штрипс


def render_label_html(unit: MaterialUnit) -> str:
    qr_src = qr_data_uri(str(unit.id))
    color = indicator_color(unit)
    parent_line = f"<div class='meta'>Из рулона №{unit.parent_id}</div>" if unit.parent_id else ""
    created_date = unit.created_at.strftime("%d.%m.%Y") if unit.created_at else ""

    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетка №{unit.id}</title>
<style>
  @page {{ size: 60mm 90mm; margin: 3mm; }}
  body {{ font-family: "Calibri", "Segoe UI", Arial, sans-serif; margin: 0; color: {NAVY}; }}
  .label {{ width: 54mm; text-align: center; border: 1px solid {BORDER}; border-radius: 10px; overflow: hidden; }}
  .bar {{ height: 6mm; background: {color}; }}
  .body {{ padding: 3mm; }}
  .qr-frame {{ width: 34mm; height: 34mm; margin: 0 auto; background: #F5F5F4; border-radius: 6px; display: flex; align-items: center; justify-content: center; }}
  .qr {{ width: 30mm; height: 30mm; }}
  .id {{ font-family: "Cambria", Georgia, serif; font-size: 16pt; font-weight: bold; margin: 2mm 0; }}
  .attrs {{ font-size: 10pt; font-weight: bold; line-height: 1.3; }}
  .meta {{ font-size: 7pt; color: {GRAY}; margin-top: 2mm; }}
  @media print {{ .no-print {{ display: none; }} }}
</style>
</head>
<body>
  <div class="label">
    <div class="bar"></div>
    <div class="body">
      <div class="qr-frame"><img class="qr" src="{qr_src}" alt="QR {unit.id}"></div>
      <div class="id">№ {unit.id}</div>
      <div class="attrs">
        {unit.material_sku.material.name}<br>
        {unit.material_sku.color.name}, {unit.material_sku.thickness.value_mm} мм<br>
        {unit.material_sku.manufacturer.name}
      </div>
      <div class="meta">
        УПД {unit.upd_number}, паллета {unit.pallet_number}<br>
        от {created_date}
        {parent_line}
      </div>
    </div>
  </div>
  <div class="no-print">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""
