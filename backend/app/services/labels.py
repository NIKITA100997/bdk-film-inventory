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


def indicator_color(unit: MaterialUnit) -> str:
    """Цветная полоса-индикатор на этикетке (раздел 4.1 ТЗ): статус на
    момент печати, не переопределяется позже. Пока без ABC-анализа (этап 7)
    "свободный остаток" (серый) не различаем — целый рулон/штрипс определяем
    по наличию parent_id."""
    return "#2f9e44" if unit.parent_id is None else "#1c7ed6"  # зелёный / синий


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
  body {{ font-family: Arial, sans-serif; margin: 0; }}
  .label {{ width: 54mm; text-align: center; }}
  .bar {{ height: 6mm; background: {color}; border-radius: 2px; margin-bottom: 3mm; }}
  .qr {{ width: 34mm; height: 34mm; }}
  .id {{ font-size: 16pt; font-weight: bold; margin: 2mm 0; }}
  .attrs {{ font-size: 10pt; font-weight: bold; line-height: 1.3; }}
  .meta {{ font-size: 7pt; color: #444; margin-top: 2mm; }}
  @media print {{ .no-print {{ display: none; }} }}
</style>
</head>
<body>
  <div class="label">
    <div class="bar"></div>
    <img class="qr" src="{qr_src}" alt="QR {unit.id}">
    <div class="id">№ {unit.id}</div>
    <div class="attrs">
      {unit.material}<br>
      {unit.color}, {unit.thickness} мм<br>
      {unit.manufacturer}
    </div>
    <div class="meta">
      УПД {unit.upd_number}, паллета {unit.pallet_number}<br>
      от {created_date}
      {parent_line}
    </div>
  </div>
  <div class="no-print">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""
