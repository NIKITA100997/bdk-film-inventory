"""Макет этикетки — не жёсткий HTML-шаблон, а структура (список полей +
порядок + опции отображения), которую render_label_html интерпретирует
(4 раздел бэклога доработок). LabelData — плоский снимок нужных для печати
данных, чтобы render_field_value была чистой функцией без ORM/БД —
тестируется напрямую, а превью макета может использовать синтетические
данные без реальной единицы в базе."""

import base64
import os
from dataclasses import dataclass
from datetime import date
from io import BytesIO

import qrcode
from reportlab.lib.colors import HexColor
from reportlab.lib.units import mm as MM
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as pdfcanvas

from app.models.units import MaterialUnit

# Палитра — из презентации БДК (БДК_Презентация_v3_учет_пленок.pptx):
# зелёный/тёмно-синий вместо исходных зелёного/синего, чтобы не вводить
# отдельный акцентный цвет, которого нет в общей дизайн-системе приложения.
NAVY = "#2C2E3A"
GRAY = "#6B6B68"
BORDER = "#DEDEDA"
GREEN = "#1D9E75"

SIZE_PT = {"sm": 8, "md": 10, "lg": 16}

DEFAULT_WIDTH_MM = 100
DEFAULT_HEIGHT_MM = 40

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
    родителя) — тогда строка в теле этикетки просто пропускается.

    Каждое поле печатается с подписью ("Ширина: 1400 мм", а не голое
    "1400 мм") — на маленькой бирке значение без подписи неоднозначно.
    Исключения — unit_id и parent_ref: подпись у них уже встроена в саму
    формулировку ("№ 42", "Из рулона №7"), отдельная приставка была бы
    задвоением."""
    if key == "unit_id":
        return f"№ {data.unit_id}"
    if key == "material":
        return f"Материал: {data.material}"
    if key == "color":
        return f"Цвет: {data.color}"
    if key == "thickness":
        return f"Толщина: {data.thickness_mm} мм"
    if key == "manufacturer":
        return f"Производитель: {data.manufacturer}"
    if key == "upd_number":
        return f"УПД: {data.upd_number}"
    if key == "pallet_number":
        return f"Паллета: {data.pallet_number}"
    if key == "received_date":
        return f"Дата приёмки: {data.received_date.strftime('%d.%m.%Y')}" if data.received_date else ""
    if key == "supplier_code":
        return f"Код у поставщика: {data.supplier_code}" if data.supplier_code else ""
    if key == "native_width":
        return f"Родная ширина: {data.native_width_mm} мм" if data.native_width_mm is not None else ""
    if key == "parent_ref":
        return f"Из рулона №{data.parent_id}" if data.parent_id else None
    if key == "width_mm":
        return f"Ширина: {data.width_mm} мм"
    if key == "length_m":
        return f"Длина: {data.length_m} м"
    return None


def qr_png_bytes(payload: str) -> bytes:
    img = qrcode.make(payload, border=1)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def qr_data_uri(payload: str) -> str:
    encoded = base64.b64encode(qr_png_bytes(payload)).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _label_markup(
    data: LabelData,
    *,
    fields: list[dict],
    width_mm: int,
    height_mm: int,
) -> str:
    """Разметка одной этикетки (таблица/бокс) без обёртки в целый HTML-документ
    — используется и для одиночной страницы (render_label_html), и для
    печати очередью, где несколько таких блоков идут один за другим с
    разрывом страницы между ними (render_labels_html_batch)."""
    color = indicator_color(data)
    qr_src = qr_data_uri(str(data.unit_id))

    is_landscape = width_mm >= height_mm
    has_stripe = any(f["key"] == "status_stripe" for f in fields)
    has_qr = any(f["key"] == "qr" for f in fields)

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        key = f["key"]
        if key in ("status_stripe", "qr"):
            continue
        val = render_field_value(data, key)
        if val:
            rendered_fields.append((f, val))

    if is_landscape:
        # ПРЯМОУГОЛЬНЫЙ / АЛЬБОМНЫЙ МАКЕТ (например 100×40 мм)
        # QR-код слева в отдельной ячейке таблицы, текстовые поля справа в отдельной ячейке
        stripe_html = f'<td class="stripe-td" style="background:{color}; width:4mm;"></td>' if has_stripe else ""

        qr_size_mm = max(min(height_mm - 6, 34), 16)
        qr_html = (
            f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
            f'<img src="{qr_src}" alt="QR {data.unit_id}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</td>'
            if has_qr
            else ""
        )

        text_html_items = []
        for f, val in rendered_fields:
            size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
            weight = "bold" if f.get("bold") else "normal"
            is_id = f["key"] == "unit_id"
            font_family = 'font-family:"Cambria", Georgia, serif;' if is_id else ""
            margin = "margin-bottom:1mm;" if is_id else "margin-bottom:0.5mm;"
            text_html_items.append(
                f'<div style="font-size:{size_pt}pt; font-weight:{weight}; {font_family} {margin} line-height:1.2;">{val}</div>'
            )

        return f"""<table class="label-table">
    <tr>
      {stripe_html}
      {qr_html}
      <td class="text-td">
        {"".join(text_html_items)}
      </td>
    </tr>
  </table>"""
    else:
        # ВЕРТИКАЛЬНЫЙ МАКЕТ (например 60×90 мм)
        stripe_html = f'<div class="stripe-h" style="background:{color}; height:5mm; width:100%;"></div>' if has_stripe else ""

        body_items = []
        for f in fields:
            key = f["key"]
            if key == "status_stripe":
                continue
            if key == "qr":
                body_items.append(
                    f'<div style="margin: 1mm 0; text-align:center;">'
                    f'<img src="{qr_src}" alt="QR {data.unit_id}" style="width:28mm; height:28mm; display:block; margin:0 auto;">'
                    f'</div>'
                )
            else:
                val = render_field_value(data, key)
                if val:
                    size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
                    weight = "bold" if f.get("bold") else "normal"
                    is_id = f["key"] == "unit_id"
                    font_family = 'font-family:"Cambria", Georgia, serif;' if is_id else ""
                    body_items.append(
                        f'<div style="font-size:{size_pt}pt; font-weight:{weight}; {font_family} margin-bottom:1mm; line-height:1.25;">{val}</div>'
                    )

        return f"""<div class="label-box">
    {stripe_html}
    <div class="content-box">
      {"".join(body_items)}
    </div>
  </div>"""


def _label_doc_styles(width_mm: int, height_mm: int) -> str:
    return f"""
  @page {{ size: {width_mm}mm {height_mm}mm; margin: 0; }}
  * {{ box-sizing: border-box; }}
  html, body {{ margin: 0; padding: 0; font-family: "Calibri", "Segoe UI", Arial, sans-serif; color: {NAVY}; background: #fff; }}
  table.label-table {{ width: {width_mm}mm; height: {height_mm}mm; border-collapse: collapse; table-layout: fixed; border: 1px solid {BORDER}; border-radius: 4px; overflow: hidden; }}
  td.stripe-td {{ height: 100%; padding: 0; }}
  td.qr-td {{ vertical-align: middle; text-align: center; }}
  td.text-td {{ vertical-align: middle; text-align: left; padding: 2mm 3mm 2mm 1mm; overflow: hidden; word-break: break-word; }}
  .label-box {{ width: {width_mm}mm; height: {height_mm}mm; border: 1px solid {BORDER}; border-radius: 6px; overflow: hidden; display: block; position: relative; }}
  .content-box {{ padding: 2mm; text-align: center; }}
  .label-page {{ width: {width_mm}mm; height: {height_mm}mm; overflow: hidden; }}
  .label-page + .label-page {{ page-break-before: always; }}
  @media print {{ .no-print {{ display: none; }} }}
"""


def render_label_html(
    data: LabelData,
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_WIDTH_MM,
    height_mm: int = DEFAULT_HEIGHT_MM,
) -> str:
    """HTML-версия этикетки — печатается через нативный window.print() браузера
    вместо PDF-blob. На планшетах (Android Chrome/Яндекс.Браузер) печать PDF,
    открытого как blob-URL, оказалась ненадёжной (система перехватывает blob
    как файл на скачивание в обход печати) — печать обычной HTML-страницы
    таких проблем не имеет, это стандартный путь через Print Service
    Framework Android. Для десктопного термопринтера (Codex G500) остаётся
    PDF-путь (render_label_pdf) — там раньше была обратная проблема с прямой
    печатью HTML."""
    fields = fields if fields is not None else DEFAULT_FIELDS
    markup = _label_markup(data, fields=fields, width_mm=width_mm, height_mm=height_mm)
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетка №{data.unit_id}</title>
<style>{_label_doc_styles(width_mm, height_mm)}</style>
</head>
<body>
  <div class="label-page">{markup}</div>
  <div class="no-print" style="margin-top: 8px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


def render_labels_html_batch(
    items: list[LabelData],
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_WIDTH_MM,
    height_mm: int = DEFAULT_HEIGHT_MM,
) -> str:
    """Несколько этикеток одной HTML-страницей — печать очередью с планшета
    (аналог render_labels_pdf_batch для PDF-пути). Каждая этикетка на своей
    печатной странице через CSS page-break-before, без открытия N вкладок."""
    fields = fields if fields is not None else DEFAULT_FIELDS
    pages = "".join(
        f'<div class="label-page">{_label_markup(d, fields=fields, width_mm=width_mm, height_mm=height_mm)}</div>'
        for d in items
    )
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетки ({len(items)})</title>
<style>{_label_doc_styles(width_mm, height_mm)}</style>
</head>
<body>
  {pages}
  <div class="no-print" style="margin-top: 8px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


_PDF_FONTS_REGISTERED = False
_PDF_BODY_FONT = "Helvetica"
_PDF_BODY_FONT_BOLD = "Helvetica-Bold"
_PDF_HEADING_FONT_BOLD = "Helvetica-Bold"


def _register_pdf_fonts() -> None:
    """Встроенные PDF-шрифты (Helvetica и весь "base 14" набор) не знают
    кириллицы — без этого текст на PDF-этикетке печатался бы квадратами.
    Регистрируем те же шрифты, что и в вебе (Calibri/Cambria, theme.ts),
    прямо из системной папки шрифтов Windows: копировать сами файлы в
    репозиторий нельзя (лицензия Microsoft на сами файлы шрифта), а
    ссылаться на уже установленную вместе с ОС копию — можно, ровно так
    это делает и сама система. Кэшируем результат на уровне модуля — файлы
    шрифтов читаются с диска один раз за жизнь процесса, не на каждую
    этикетку. Если файлов нет (не Windows) — тихий откat на Helvetica:
    кириллица не отобразится, но PDF всё равно сгенерируется, не упадёт."""
    global _PDF_FONTS_REGISTERED, _PDF_BODY_FONT, _PDF_BODY_FONT_BOLD, _PDF_HEADING_FONT_BOLD
    if _PDF_FONTS_REGISTERED:
        return
    _PDF_FONTS_REGISTERED = True
    fonts_dir = r"C:\Windows\Fonts"
    try:
        pdfmetrics.registerFont(TTFont("Calibri", os.path.join(fonts_dir, "calibri.ttf")))
        pdfmetrics.registerFont(TTFont("Calibri-Bold", os.path.join(fonts_dir, "calibrib.ttf")))
        pdfmetrics.registerFont(TTFont("Cambria-Bold", os.path.join(fonts_dir, "cambriab.ttf")))
        _PDF_BODY_FONT = "Calibri"
        _PDF_BODY_FONT_BOLD = "Calibri-Bold"
        _PDF_HEADING_FONT_BOLD = "Cambria-Bold"
    except Exception:
        pass


def _draw_label_page(
    c: pdfcanvas.Canvas,
    data: LabelData,
    fields: list[dict],
    width_mm: int,
    height_mm: int,
) -> None:
    """Рисует одну этикетку на уже открытой странице канваса — не создаёт
    Canvas и не вызывает showPage/save, чтобы один и тот же код рисования
    использовался и для одиночной этикетки (render_label_pdf), и для пакета
    в несколько страниц (render_labels_pdf_batch, раздел про очередь
    печати)."""
    color = indicator_color(data)
    is_landscape = width_mm >= height_mm
    has_stripe = any(f["key"] == "status_stripe" for f in fields)
    has_qr = any(f["key"] == "qr" for f in fields)

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        key = f["key"]
        if key in ("status_stripe", "qr"):
            continue
        val = render_field_value(data, key)
        if val:
            rendered_fields.append((f, val))

    width_pt, height_pt = width_mm * MM, height_mm * MM
    c.setStrokeColor(HexColor(BORDER))
    c.setLineWidth(0.5)
    c.roundRect(0.3 * MM, 0.3 * MM, width_pt - 0.6 * MM, height_pt - 0.6 * MM, 1.5 * MM, stroke=1, fill=0)

    qr_reader = ImageReader(BytesIO(qr_png_bytes(str(data.unit_id)))) if has_qr else None

    def draw_text_lines(left_mm: float, top_mm: float, max_width_mm: float, *, center: bool = False) -> None:
        y = height_pt - top_mm * MM
        for f, val in rendered_fields:
            size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
            if f["key"] == "unit_id":
                font_name = _PDF_HEADING_FONT_BOLD
            elif f.get("bold"):
                font_name = _PDF_BODY_FONT_BOLD
            else:
                font_name = _PDF_BODY_FONT
            c.setFont(font_name, size_pt)
            c.setFillColor(HexColor(NAVY))
            y -= size_pt * 1.15
            if center:
                c.drawCentredString((left_mm + max_width_mm / 2) * MM, y, val)
            else:
                c.drawString(left_mm * MM, y, val)

    def text_block_height_mm() -> float:
        return sum(SIZE_PT.get(f.get("size", "sm"), 8) * 1.15 * 0.3528 for f, _ in rendered_fields)

    if is_landscape:
        stripe_w_mm = 4 if has_stripe else 0
        if has_stripe:
            c.setFillColor(HexColor(color))
            c.rect(0, 0, stripe_w_mm * MM, height_pt, fill=1, stroke=0)

        qr_col_w_mm = 0.0
        if has_qr and qr_reader is not None:
            qr_size_mm = max(min(height_mm - 6, 34), 16)
            qr_col_w_mm = qr_size_mm + 4
            qr_x_mm = stripe_w_mm + (qr_col_w_mm - qr_size_mm) / 2
            qr_y_mm = (height_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, qr_y_mm * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")

        text_x_mm = stripe_w_mm + qr_col_w_mm + 2
        text_w_mm = max(width_mm - text_x_mm - 2, 5)
        top_mm = max((height_mm - text_block_height_mm()) / 2, 2)
        draw_text_lines(text_x_mm, top_mm, text_w_mm)
    else:
        top_mm = 3.0
        if has_stripe:
            c.setFillColor(HexColor(color))
            c.rect(0, height_pt - 5 * MM, width_pt, 5 * MM, fill=1, stroke=0)
            top_mm = 8.0
        if has_qr and qr_reader is not None:
            qr_size_mm = 28.0
            qr_x_mm = (width_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, height_pt - (top_mm + qr_size_mm) * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
            top_mm += qr_size_mm + 2
        draw_text_lines(4, top_mm, max(width_mm - 8, 5), center=True)


def render_label_pdf(
    data: LabelData,
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_WIDTH_MM,
    height_mm: int = DEFAULT_HEIGHT_MM,
) -> bytes:
    """PDF-версия этикетки — по итогам полевого тестирования печати (раздел
    обратной связи): прямая печать HTML-страницы из браузера на часть
    термопринтеров (проверено на Codex G500) ненадёжна — драйвер может
    молча обрезать нестандартный размер страницы или не напечатать вовсе, в
    то время как печать уже готового PDF-файла (тот же путь, что у
    браузерного "Сохранить как PDF") на том же принтере отрабатывает
    надёжно. Поэтому теперь это основной способ получить бирку, не HTML.

    Упрощённая версия макета: встроенные PDF-шрифты (Helvetica) вместо
    Cambria/Calibri и без переноса длинных строк — здесь важнее
    предсказуемая печать, чем пиксель-в-пиксель повтор HTML-варианта
    (который остаётся для просмотра в браузере)."""
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=(width_pt, height_pt))
    _draw_label_page(c, data, fields, width_mm, height_mm)
    c.showPage()
    c.save()
    return buf.getvalue()


def render_labels_pdf_batch(
    items: list[LabelData],
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_WIDTH_MM,
    height_mm: int = DEFAULT_HEIGHT_MM,
) -> bytes:
    """Один PDF на несколько этикеток вместо N отдельных — очередь печати
    (раздел про ускорение работы): при приёмке партии из N рулонов кнопка
    "Печать всех этикеток" открывала N вкладок браузера, каждая со своим
    диалогом печати. Термопринтер одинаково хорошо печатает многостраничный
    PDF постранично, так что один файл с N страницами даёт тот же
    результат за один клик вместо N."""
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=(width_pt, height_pt))
    for data in items:
        _draw_label_page(c, data, fields, width_mm, height_mm)
        c.showPage()
    c.save()
    return buf.getvalue()


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


# ─── Этикетки мест хранения (раздел про макеты для стеллажей/полок) ───
# Тот же приём "макет — структура, не HTML", тот же двойной PDF/HTML путь
# печати, но отдельные функции рендера, а не переиспользование
# _label_markup/_draw_label_page на общих данных: код печати рулонов уже
# отлажен полевым тестированием на термопринтере Codex G500, лишний риск
# регрессии того, что уже работает, ради общности того не стоит. Общее —
# только по-настоящему не зависящее от домена: qr_png_bytes/qr_data_uri,
# SIZE_PT, цвета, _register_pdf_fonts.
#
# Два независимых макета на уровне мест хранения: "shelf" — бирка на
# конкретную полку, "rack" (ниже) — бирка на весь стеллаж целиком.

DEFAULT_SHELF_WIDTH_MM = 70
DEFAULT_SHELF_HEIGHT_MM = 40

DEFAULT_FIELDS_SHELF: list[dict] = [
    {"key": "qr", "size": "md", "bold": False},
    {"key": "location_code", "size": "lg", "bold": True},
    {"key": "warehouse_name", "size": "sm", "bold": False},
    {"key": "rack_type", "size": "sm", "bold": False},
]

FIELD_META_SHELF: dict[str, dict] = {
    "qr": {"label": "QR-код", "kind": "image"},
    "location_code": {"label": "Код места (полка)", "kind": "text"},
    "warehouse_name": {"label": "Склад", "kind": "text"},
    "rack_type": {"label": "Тип стеллажа", "kind": "text"},
    "shelf": {"label": "Номер полки", "kind": "text"},
    "storage_rules": {"label": "Правила хранения", "kind": "text"},
}


@dataclass(frozen=True)
class ShelfLabelData:
    location_code: str
    warehouse_name: str
    rack_type_label: str
    shelf: int
    storage_rules_text: str | None


def render_field_value_shelf(data: ShelfLabelData, key: str) -> str | None:
    """Как render_field_value для рулона: location_code — уже сам по себе
    понятный идентификатор (как unit_id "№ 42"), без отдельной подписи."""
    if key == "location_code":
        return data.location_code
    if key == "warehouse_name":
        return f"Склад: {data.warehouse_name}"
    if key == "rack_type":
        return f"Тип: {data.rack_type_label}"
    if key == "shelf":
        return f"Полка: {data.shelf}"
    if key == "storage_rules":
        return data.storage_rules_text
    return None


def _shelf_label_markup(data: ShelfLabelData, *, fields: list[dict], width_mm: int, height_mm: int) -> str:
    qr_src = qr_data_uri(data.location_code)
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr":
            continue
        val = render_field_value_shelf(data, f["key"])
        if val:
            rendered_fields.append((f, val))

    if is_landscape:
        qr_size_mm = max(min(height_mm - 6, 34), 16)
        qr_html = (
            f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
            f'<img src="{qr_src}" alt="QR {data.location_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</td>'
            if has_qr
            else ""
        )
        text_html_items = []
        for f, val in rendered_fields:
            size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
            weight = "bold" if f.get("bold") else "normal"
            is_code = f["key"] == "location_code"
            font_family = 'font-family:"Cambria", Georgia, serif;' if is_code else ""
            margin = "margin-bottom:1mm;" if is_code else "margin-bottom:0.5mm;"
            text_html_items.append(
                f'<div style="font-size:{size_pt}pt; font-weight:{weight}; {font_family} {margin} line-height:1.2;">{val}</div>'
            )
        return f"""<table class="label-table">
    <tr>
      {qr_html}
      <td class="text-td">
        {"".join(text_html_items)}
      </td>
    </tr>
  </table>"""
    else:
        body_items = []
        for f in fields:
            if f["key"] == "qr":
                body_items.append(
                    f'<div style="margin: 1mm 0; text-align:center;">'
                    f'<img src="{qr_src}" alt="QR {data.location_code}" style="width:28mm; height:28mm; display:block; margin:0 auto;">'
                    f'</div>'
                )
                continue
            val = render_field_value_shelf(data, f["key"])
            if val:
                size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
                weight = "bold" if f.get("bold") else "normal"
                is_code = f["key"] == "location_code"
                font_family = 'font-family:"Cambria", Georgia, serif;' if is_code else ""
                body_items.append(
                    f'<div style="font-size:{size_pt}pt; font-weight:{weight}; {font_family} margin-bottom:1mm; line-height:1.25;">{val}</div>'
                )
        return f"""<div class="label-box">
    <div class="content-box">
      {"".join(body_items)}
    </div>
  </div>"""


def render_shelf_label_html(
    data: ShelfLabelData, *, fields: list[dict] | None = None, width_mm: int = DEFAULT_SHELF_WIDTH_MM, height_mm: int = DEFAULT_SHELF_HEIGHT_MM
) -> str:
    fields = fields if fields is not None else DEFAULT_FIELDS_SHELF
    markup = _shelf_label_markup(data, fields=fields, width_mm=width_mm, height_mm=height_mm)
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетка {data.location_code}</title>
<style>{_label_doc_styles(width_mm, height_mm)}</style>
</head>
<body>
  <div class="label-page">{markup}</div>
  <div class="no-print" style="margin-top: 8px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


def render_shelf_labels_html_batch(
    items: list[ShelfLabelData], *, fields: list[dict] | None = None, width_mm: int = DEFAULT_SHELF_WIDTH_MM, height_mm: int = DEFAULT_SHELF_HEIGHT_MM
) -> str:
    fields = fields if fields is not None else DEFAULT_FIELDS_SHELF
    pages = "".join(
        f'<div class="label-page">{_shelf_label_markup(d, fields=fields, width_mm=width_mm, height_mm=height_mm)}</div>'
        for d in items
    )
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетки мест хранения ({len(items)})</title>
<style>{_label_doc_styles(width_mm, height_mm)}</style>
</head>
<body>
  {pages}
  <div class="no-print" style="margin-top: 8px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


def _draw_shelf_label_page(c: pdfcanvas.Canvas, data: ShelfLabelData, fields: list[dict], width_mm: int, height_mm: int) -> None:
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr":
            continue
        val = render_field_value_shelf(data, f["key"])
        if val:
            rendered_fields.append((f, val))

    width_pt, height_pt = width_mm * MM, height_mm * MM
    c.setStrokeColor(HexColor(BORDER))
    c.setLineWidth(0.5)
    c.roundRect(0.3 * MM, 0.3 * MM, width_pt - 0.6 * MM, height_pt - 0.6 * MM, 1.5 * MM, stroke=1, fill=0)

    qr_reader = ImageReader(BytesIO(qr_png_bytes(data.location_code))) if has_qr else None

    def draw_text_lines(left_mm: float, top_mm: float, max_width_mm: float, *, center: bool = False) -> None:
        y = height_pt - top_mm * MM
        for f, val in rendered_fields:
            size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
            font_name = _PDF_HEADING_FONT_BOLD if f["key"] == "location_code" else (_PDF_BODY_FONT_BOLD if f.get("bold") else _PDF_BODY_FONT)
            c.setFont(font_name, size_pt)
            c.setFillColor(HexColor(NAVY))
            y -= size_pt * 1.15
            if center:
                c.drawCentredString((left_mm + max_width_mm / 2) * MM, y, val)
            else:
                c.drawString(left_mm * MM, y, val)

    def text_block_height_mm() -> float:
        return sum(SIZE_PT.get(f.get("size", "sm"), 8) * 1.15 * 0.3528 for f, _ in rendered_fields)

    if is_landscape:
        qr_col_w_mm = 0.0
        if has_qr and qr_reader is not None:
            qr_size_mm = max(min(height_mm - 6, 34), 16)
            qr_col_w_mm = qr_size_mm + 4
            qr_x_mm = (qr_col_w_mm - qr_size_mm) / 2
            qr_y_mm = (height_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, qr_y_mm * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
        text_x_mm = qr_col_w_mm + 2
        text_w_mm = max(width_mm - text_x_mm - 2, 5)
        top_mm = max((height_mm - text_block_height_mm()) / 2, 2)
        draw_text_lines(text_x_mm, top_mm, text_w_mm)
    else:
        top_mm = 3.0
        if has_qr and qr_reader is not None:
            qr_size_mm = 28.0
            qr_x_mm = (width_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, height_pt - (top_mm + qr_size_mm) * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
            top_mm += qr_size_mm + 2
        draw_text_lines(4, top_mm, max(width_mm - 8, 5), center=True)


def render_shelf_label_pdf(
    data: ShelfLabelData, *, fields: list[dict] | None = None, width_mm: int = DEFAULT_SHELF_WIDTH_MM, height_mm: int = DEFAULT_SHELF_HEIGHT_MM
) -> bytes:
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS_SHELF
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=(width_pt, height_pt))
    _draw_shelf_label_page(c, data, fields, width_mm, height_mm)
    c.showPage()
    c.save()
    return buf.getvalue()


def render_shelf_labels_pdf_batch(
    items: list[ShelfLabelData], *, fields: list[dict] | None = None, width_mm: int = DEFAULT_SHELF_WIDTH_MM, height_mm: int = DEFAULT_SHELF_HEIGHT_MM
) -> bytes:
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS_SHELF
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=(width_pt, height_pt))
    for data in items:
        _draw_shelf_label_page(c, data, fields, width_mm, height_mm)
        c.showPage()
    c.save()
    return buf.getvalue()


RACK_TYPE_LABELS = {"roll": "Рулонный", "strip": "Штрипсовый"}

PREVIEW_DATA_SHELF = ShelfLabelData(
    location_code="Р-3-07",
    warehouse_name="Основной склад",
    rack_type_label="Рулонный",
    shelf=7,
    storage_rules_text="ПВХ, Дуб беленый, 0.35 мм, Классен",
)


# ─── Этикетка стеллажа целиком (kind="rack") ───
# Бирка на весь стеллаж (например, табличка у входа в ряд с кодом
# «Р-3»), отдельно от бирок на отдельные места хранения выше. Печатается
# по одной за раз — батч-версия не нужна, у стеллажа одна бирка.

DEFAULT_RACK_WIDTH_MM = 70
DEFAULT_RACK_HEIGHT_MM = 40

DEFAULT_FIELDS_RACK: list[dict] = [
    {"key": "qr", "size": "md", "bold": False},
    {"key": "rack_code", "size": "lg", "bold": True},
    {"key": "warehouse_name", "size": "sm", "bold": False},
    {"key": "rack_type", "size": "sm", "bold": False},
    {"key": "shelf_count", "size": "sm", "bold": False},
]

FIELD_META_RACK: dict[str, dict] = {
    "qr": {"label": "QR-код", "kind": "image"},
    "rack_code": {"label": "Код стеллажа", "kind": "text"},
    "warehouse_name": {"label": "Склад", "kind": "text"},
    "rack_type": {"label": "Тип стеллажа", "kind": "text"},
    "shelf_count": {"label": "Число полок", "kind": "text"},
    "storage_rules": {"label": "Правила хранения", "kind": "text"},
}


@dataclass(frozen=True)
class RackLabelData:
    rack_code: str
    warehouse_name: str
    rack_type_label: str
    shelf_count: int
    storage_rules_text: str | None


def render_field_value_rack(data: RackLabelData, key: str) -> str | None:
    """rack_code — главная строка бирки, без подписи (как location_code/
    unit_id у соседних макетов); storage_rules — уже готовая сводка всех
    правил стеллажа или None, если правил нет (поле тогда просто
    пропускается, как parent_ref у единицы без родителя)."""
    if key == "rack_code":
        return data.rack_code
    if key == "warehouse_name":
        return f"Склад: {data.warehouse_name}"
    if key == "rack_type":
        return f"Тип: {data.rack_type_label}"
    if key == "shelf_count":
        return f"Полок: {data.shelf_count}"
    if key == "storage_rules":
        return data.storage_rules_text
    return None


def _rack_label_markup(data: RackLabelData, *, fields: list[dict], width_mm: int, height_mm: int) -> str:
    qr_src = qr_data_uri(data.rack_code)
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr":
            continue
        val = render_field_value_rack(data, f["key"])
        if val:
            rendered_fields.append((f, val))

    if is_landscape:
        qr_size_mm = max(min(height_mm - 6, 34), 16)
        qr_html = (
            f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
            f'<img src="{qr_src}" alt="QR {data.rack_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</td>'
            if has_qr
            else ""
        )
        text_html_items = []
        for f, val in rendered_fields:
            size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
            weight = "bold" if f.get("bold") else "normal"
            is_code = f["key"] == "rack_code"
            font_family = 'font-family:"Cambria", Georgia, serif;' if is_code else ""
            margin = "margin-bottom:1mm;" if is_code else "margin-bottom:0.5mm;"
            text_html_items.append(
                f'<div style="font-size:{size_pt}pt; font-weight:{weight}; {font_family} {margin} line-height:1.2;">{val}</div>'
            )
        return f"""<table class="label-table">
    <tr>
      {qr_html}
      <td class="text-td">
        {"".join(text_html_items)}
      </td>
    </tr>
  </table>"""
    else:
        body_items = []
        for f in fields:
            if f["key"] == "qr":
                body_items.append(
                    f'<div style="margin: 1mm 0; text-align:center;">'
                    f'<img src="{qr_src}" alt="QR {data.rack_code}" style="width:28mm; height:28mm; display:block; margin:0 auto;">'
                    f'</div>'
                )
                continue
            val = render_field_value_rack(data, f["key"])
            if val:
                size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
                weight = "bold" if f.get("bold") else "normal"
                is_code = f["key"] == "rack_code"
                font_family = 'font-family:"Cambria", Georgia, serif;' if is_code else ""
                body_items.append(
                    f'<div style="font-size:{size_pt}pt; font-weight:{weight}; {font_family} margin-bottom:1mm; line-height:1.25;">{val}</div>'
                )
        return f"""<div class="label-box">
    <div class="content-box">
      {"".join(body_items)}
    </div>
  </div>"""


def render_rack_label_html(
    data: RackLabelData, *, fields: list[dict] | None = None, width_mm: int = DEFAULT_RACK_WIDTH_MM, height_mm: int = DEFAULT_RACK_HEIGHT_MM
) -> str:
    fields = fields if fields is not None else DEFAULT_FIELDS_RACK
    markup = _rack_label_markup(data, fields=fields, width_mm=width_mm, height_mm=height_mm)
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетка стеллажа {data.rack_code}</title>
<style>{_label_doc_styles(width_mm, height_mm)}</style>
</head>
<body>
  <div class="label-page">{markup}</div>
  <div class="no-print" style="margin-top: 8px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


def _draw_rack_label_page(c: pdfcanvas.Canvas, data: RackLabelData, fields: list[dict], width_mm: int, height_mm: int) -> None:
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr":
            continue
        val = render_field_value_rack(data, f["key"])
        if val:
            rendered_fields.append((f, val))

    width_pt, height_pt = width_mm * MM, height_mm * MM
    c.setStrokeColor(HexColor(BORDER))
    c.setLineWidth(0.5)
    c.roundRect(0.3 * MM, 0.3 * MM, width_pt - 0.6 * MM, height_pt - 0.6 * MM, 1.5 * MM, stroke=1, fill=0)

    qr_reader = ImageReader(BytesIO(qr_png_bytes(data.rack_code))) if has_qr else None

    def draw_text_lines(left_mm: float, top_mm: float, max_width_mm: float, *, center: bool = False) -> None:
        y = height_pt - top_mm * MM
        for f, val in rendered_fields:
            size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
            font_name = _PDF_HEADING_FONT_BOLD if f["key"] == "rack_code" else (_PDF_BODY_FONT_BOLD if f.get("bold") else _PDF_BODY_FONT)
            c.setFont(font_name, size_pt)
            c.setFillColor(HexColor(NAVY))
            y -= size_pt * 1.15
            if center:
                c.drawCentredString((left_mm + max_width_mm / 2) * MM, y, val)
            else:
                c.drawString(left_mm * MM, y, val)

    def text_block_height_mm() -> float:
        return sum(SIZE_PT.get(f.get("size", "sm"), 8) * 1.15 * 0.3528 for f, _ in rendered_fields)

    if is_landscape:
        qr_col_w_mm = 0.0
        if has_qr and qr_reader is not None:
            qr_size_mm = max(min(height_mm - 6, 34), 16)
            qr_col_w_mm = qr_size_mm + 4
            qr_x_mm = (qr_col_w_mm - qr_size_mm) / 2
            qr_y_mm = (height_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, qr_y_mm * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
        text_x_mm = qr_col_w_mm + 2
        text_w_mm = max(width_mm - text_x_mm - 2, 5)
        top_mm = max((height_mm - text_block_height_mm()) / 2, 2)
        draw_text_lines(text_x_mm, top_mm, text_w_mm)
    else:
        top_mm = 3.0
        if has_qr and qr_reader is not None:
            qr_size_mm = 28.0
            qr_x_mm = (width_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, height_pt - (top_mm + qr_size_mm) * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
            top_mm += qr_size_mm + 2
        draw_text_lines(4, top_mm, max(width_mm - 8, 5), center=True)


def render_rack_label_pdf(
    data: RackLabelData, *, fields: list[dict] | None = None, width_mm: int = DEFAULT_RACK_WIDTH_MM, height_mm: int = DEFAULT_RACK_HEIGHT_MM
) -> bytes:
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS_RACK
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=(width_pt, height_pt))
    _draw_rack_label_page(c, data, fields, width_mm, height_mm)
    c.showPage()
    c.save()
    return buf.getvalue()


PREVIEW_DATA_RACK = RackLabelData(
    rack_code="Р-3",
    warehouse_name="Основной склад",
    rack_type_label="Рулонный",
    shelf_count=12,
    storage_rules_text="Полки 1–4: любой; Полки 5–12: ПВХ, Дуб беленый, 0.35 мм, Классен",
)
