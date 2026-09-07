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
from typing import Literal

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
# Относительный вес обычного (не "huge") поля при печати в формате А4
# (раздел про большой формат) — доля доступной высоты, которую получит
# поле при автоподборе кегля через _draw_giant_field_pdf/_giant_field_html
# (тот же механизм, что уже даёт size="huge"), пропорциональна тому, каким
# кеглем оно печаталось бы на обычной наклейке.
SIZE_WEIGHT = {"sm": 1.0, "md": 1.3, "lg": 1.8}

DEFAULT_WIDTH_MM = 100
DEFAULT_HEIGHT_MM = 40

# Раздел про печать в формате А4 (объёмные объекты — поддон/стеллаж/
# крупная партия, для которых обычная маленькая наклейка нечитаема).
# Формат страницы — runtime-параметр печати, как и `vertical` (поворот
# 90°) ниже, а не поле шаблона в БД: то же самое сохранённое поле макета
# можно напечатать и обычной наклейкой, и на весь лист А4.
PageFormat = Literal["sticker", "a4"]


def resolve_page_format_dims(width_mm: int, height_mm: int, page_format: PageFormat) -> tuple[int, int]:
    """Размер физической страницы для печати — при "sticker" совпадает с
    геометрией сохранённого шаблона (ничего не меняется), при "a4" —
    210×297мм с сохранением ориентации шаблона (широкий шаблон остаётся
    альбомным, узкий — книжным), чтобы раскладка полей (is_landscape
    внутри markup/draw-функций) не переключалась неожиданно."""
    if page_format == "sticker":
        return width_mm, height_mm
    return (297, 210) if width_mm >= height_mm else (210, 297)


def _qr_size_mm(width_mm: int, height_mm: int, page_format: PageFormat, *, is_landscape: bool, giant: bool = False) -> float:
    """QR был жёстко закапан на маленький размер (до ~34мм) независимо от
    размера страницы — на А4 это выглядело бы потерянным на большом пустом
    листе. При "sticker" — точно прежние формулы (поведение не меняется);
    при "a4" — пропорционально стороне страницы, тоже с потолком, чтобы
    оставалось место под текстовые поля."""
    if page_format == "sticker":
        return max(min(height_mm - 6, 34), 16) if is_landscape else (24.0 if giant else 28.0)
    basis = height_mm if is_landscape else width_mm
    return max(min(basis * 0.55, 120), 40)

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
    "parent_ref": {"label": "Из рулона №…", "kind": "text", "has_caption": False},
    "width_mm": {"label": "Ширина (текущая), мм", "kind": "text", "stale_warning": True},
    "length_m": {"label": "Длина (текущая), м", "kind": "text", "stale_warning": True},
    "dimensions_m": {"label": "Габарит Ш(мм)×Д(м) (компактно)", "kind": "text", "stale_warning": True, "has_caption": False},
    # Раздел про этикетку с назначением после резки — несколько штрипсов
    # одной ширины, выданных на разные задания/детали, иначе неотличимы
    # на глаз. Пусто у единиц без привязки к строке задания (обычные
    # остатки на складе) — строка просто пропускается, как и parent_ref.
    "task_assignment": {"label": "Назначение (задание/деталь)", "kind": "text"},
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
    is_strip: bool
    width_mm: float
    length_m: float
    task_name: str | None = None
    part_name: str | None = None


def label_data_from_unit(unit: MaterialUnit) -> LabelData:
    sku = unit.material_sku
    line = unit.production_task_line
    task_name = None
    if line is not None:
        task_name = (line.task.product_model.name if line.task.product_model else None) or line.task.name
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
        is_strip=unit.is_strip,
        width_mm=float(unit.width_mm),
        length_m=float(unit.length_m),
        task_name=task_name,
        part_name=line.part_name if line is not None else None,
    )


def indicator_color(data: LabelData) -> str:
    """Цветная полоса-индикатор (раздел 4.1 ТЗ): целый рулон — зелёный,
    штрипс — тёмно-синий (MaterialUnit.is_strip, раздел про приёмку
    отдельных штрипсов). Пока без ABC-анализа "свободный остаток" (серый)
    не различаем."""
    return NAVY if data.is_strip else GREEN


def _format_number_ru(value: float) -> str:
    """1.400 -> "1,4", 1.000 -> "1" — компактный вид без незначащих нулей и
    с русским десятичным разделителем (раздел про габарит на этикетке —
    экономия места важнее, чем единообразная точность)."""
    text = f"{value:.3f}".rstrip("0").rstrip(".")
    return text.replace(".", ",")


def render_field_value(data: LabelData, key: str, *, show_label: bool = True) -> str | None:
    """None — поле нечего показывать (например, единица не резалась из
    родителя) — тогда строка в теле этикетки просто пропускается.

    По умолчанию каждое поле печатается с подписью ("Материал: ПВХ", а не
    голое "ПВХ") — на маленькой бирке значение без подписи неоднозначно;
    show_label=False убирает её (раздел про возможность убрать подпись),
    оставляя только значение (для thickness/native_width/width_mm/length_m
    единица измерения — "мм"/"м" — остаётся: это часть значения, не
    подпись). parent_ref и dimensions_m подписи не имеют вовсе (значение
    уже самодостаточно — "Из рулона №7", "1,4×500"), show_label для них не
    действует."""
    if key == "unit_id":
        return f"№ {data.unit_id}" if show_label else str(data.unit_id)
    if key == "material":
        return f"Материал: {data.material}" if show_label else data.material
    if key == "color":
        return f"Цвет: {data.color}" if show_label else data.color
    if key == "thickness":
        value = f"{data.thickness_mm} мм"
        return f"Толщина: {value}" if show_label else value
    if key == "manufacturer":
        return f"Производитель: {data.manufacturer}" if show_label else data.manufacturer
    if key == "upd_number":
        return f"УПД: {data.upd_number}" if show_label else data.upd_number
    if key == "pallet_number":
        return f"Паллета: {data.pallet_number}" if show_label else data.pallet_number
    if key == "received_date":
        if not data.received_date:
            return ""
        value = data.received_date.strftime("%d.%m.%Y")
        return f"Дата приёмки: {value}" if show_label else value
    if key == "supplier_code":
        if not data.supplier_code:
            return ""
        return f"Код у поставщика: {data.supplier_code}" if show_label else data.supplier_code
    if key == "native_width":
        if data.native_width_mm is None:
            return ""
        value = f"{data.native_width_mm} мм"
        return f"Родная ширина: {value}" if show_label else value
    if key == "parent_ref":
        return f"Из рулона №{data.parent_id}" if data.parent_id else None
    if key == "width_mm":
        value = f"{data.width_mm} мм"
        return f"Ш: {value}" if show_label else value
    if key == "length_m":
        value = f"{data.length_m} м"
        return f"Д: {value}" if show_label else value
    if key == "dimensions_m":
        # Ширина в мм (не в метрах — доли метра нечитаемы на узких
        # штрипсах, напр. "0,096"), длина в метрах как была; разделитель
        # "*" — компактная запись "370мм*500" вместо двух отдельных строк
        # "Ширина: 370 мм" / "Длина: 500 м", когда на бирке не хватает
        # места на обе.
        return f"{_format_number_ru(data.width_mm)}мм*{_format_number_ru(data.length_m)}"
    if key == "task_assignment":
        if not data.task_name and not data.part_name:
            return None
        parts = [p for p in (data.part_name, data.task_name) if p]
        value = " — ".join(parts)
        return f"Куда: {value}" if show_label else value
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
    page_format: PageFormat = "sticker",
) -> str:
    """Разметка одной этикетки (таблица/бокс) без обёртки в целый HTML-документ
    — используется и для одиночной страницы (render_label_html), и для
    печати очередью, где несколько таких блоков идут один за другим с
    разрывом страницы между ними (render_labels_html_batch)."""
    _register_pdf_fonts()
    color = indicator_color(data)
    qr_src = qr_data_uri(str(data.unit_id))

    is_landscape = width_mm >= height_mm
    has_stripe = any(f["key"] == "status_stripe" for f in fields)
    has_qr = any(f["key"] == "qr" for f in fields)
    giant_field = next((f for f in fields if f.get("size") == "huge"), None)

    if giant_field is not None:
        vertical = bool(giant_field.get("vertical"))
        # Вертикальная раскладка (по символу на строку) всегда без подписи
        # — многословную/составную подпись, разбитую по буквам в столбик,
        # прочитать нельзя (см. историю бага с "№" у unit_id — тот же
        # эффект случился бы с любой другой подписью, не только с этой).
        giant_val = render_field_value(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not vertical) or ""
        if is_landscape:
            stripe_html = f'<td class="stripe-td" style="background:{color}; width:4mm;"></td>' if has_stripe else ""
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=True, giant=True)
            qr_html = (
                f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
                f'<img src="{qr_src}" alt="QR {data.unit_id}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</td>'
                if has_qr
                else ""
            )
            used_w_mm = (4 if has_stripe else 0) + (qr_size_mm + 4 if has_qr else 0)
            text_w_mm = max(width_mm - used_w_mm - 2, 5)
            giant_html = _giant_field_html(
                giant_val, _PDF_HEADING_FONT_BOLD, width_mm=text_w_mm, avail_height_mm=height_mm - 2, vertical=vertical,
                font_family_css='font-family:"Cambria", Georgia, serif;',
            )
            return f"""<table class="label-table">
    <tr>
      {stripe_html}
      {qr_html}
      <td class="text-td" style="text-align:center;">
        {giant_html}
      </td>
    </tr>
  </table>"""
        else:
            stripe_html = f'<div class="stripe-h" style="background:{color}; height:5mm; width:100%;"></div>' if has_stripe else ""
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=False, giant=True)
            qr_html = (
                f'<div style="margin: 1mm 0; text-align:center;">'
                f'<img src="{qr_src}" alt="QR {data.unit_id}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</div>'
                if has_qr
                else ""
            )
            avail_height_mm = height_mm - (5 if has_stripe else 0) - (qr_size_mm + 2 if has_qr else 2)
            giant_html = _giant_field_html(
                giant_val, _PDF_HEADING_FONT_BOLD, width_mm=width_mm - 4, avail_height_mm=avail_height_mm, vertical=vertical,
                font_family_css='font-family:"Cambria", Georgia, serif;',
            )
            return f"""<div class="label-box">
    {stripe_html}
    {qr_html}
    <div class="content-box" style="padding:0;">
      {giant_html}
    </div>
  </div>"""

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        key = f["key"]
        if key in ("status_stripe", "qr"):
            continue
        val = render_field_value(data, key, show_label=f.get("show_label", True))
        if val:
            rendered_fields.append((f, val))

    if is_landscape:
        # ПРЯМОУГОЛЬНЫЙ / АЛЬБОМНЫЙ МАКЕТ (например 100×40 мм)
        # QR-код слева в отдельной ячейке таблицы, текстовые поля справа в отдельной ячейке
        stripe_html = f'<td class="stripe-td" style="background:{color}; width:4mm;"></td>' if has_stripe else ""

        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=True)
        qr_html = (
            f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
            f'<img src="{qr_src}" alt="QR {data.unit_id}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</td>'
            if has_qr
            else ""
        )

        text_w_mm = max(width_mm - (4 if has_stripe else 0) - (qr_size_mm + 4 if has_qr else 0) - 2, 5)
        if page_format == "a4":
            text_html = _autofit_fields_html(rendered_fields, width_mm=text_w_mm, avail_height_mm=height_mm - 2, heading_key="unit_id")
        else:
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
            text_html = "".join(text_html_items)

        return f"""<table class="label-table">
    <tr>
      {stripe_html}
      {qr_html}
      <td class="text-td">
        {text_html}
      </td>
    </tr>
  </table>"""
    else:
        # ВЕРТИКАЛЬНЫЙ МАКЕТ (например 60×90 мм)
        stripe_html = f'<div class="stripe-h" style="background:{color}; height:5mm; width:100%;"></div>' if has_stripe else ""
        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=False)

        if page_format == "a4":
            qr_html = (
                f'<div style="margin: 1mm 0; text-align:center;">'
                f'<img src="{qr_src}" alt="QR {data.unit_id}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</div>'
                if has_qr
                else ""
            )
            avail_height_mm = height_mm - (5 if has_stripe else 0) - (qr_size_mm + 2 if has_qr else 2)
            body_html = _autofit_fields_html(rendered_fields, width_mm=width_mm - 4, avail_height_mm=avail_height_mm, heading_key="unit_id")
            return f"""<div class="label-box">
    {stripe_html}
    {qr_html}
    <div class="content-box">
      {body_html}
    </div>
  </div>"""

        # "sticker" — сохраняем порядок полей как задан в шаблоне (QR может
        # стоять не первым), а не переставляем его в фиксированную позицию.
        body_items = []
        for f in fields:
            key = f["key"]
            if key == "status_stripe":
                continue
            if key == "qr":
                body_items.append(
                    f'<div style="margin: 1mm 0; text-align:center;">'
                    f'<img src="{qr_src}" alt="QR {data.unit_id}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                    f'</div>'
                )
            else:
                val = render_field_value(data, key, show_label=f.get("show_label", True))
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


def _label_doc_styles(width_mm: int, height_mm: int, vertical: bool = False) -> str:
    """Раздел про ориентацию печати. При vertical=True физическая страница
    (@page) повёрнута (width_mm/height_mm меняются местами).

    Две неудачные попытки до этой версии, обе выявлены живой печатью, не
    угадыванием:
    1) Поворот и layout-размер на одном и том же .label-page — работало на
       экране, но на планшете (Android Print Service Framework) печать
       ломалась целиком: layout-бокс (по нему движок считает разбивку на
       страницы) не совпадал с объявленным @page. Десктопный PDF-путь
       (честный canvas) это не задевало.
    2) Разнесли на .label-page (layout, всегда = @page) и
       .label-page-inner с position:absolute (сам поворот) — почему-то
       при печати ПАЧКИ этикеток (много страниц) печаталась только
       ПОСЛЕДНЯЯ страница, остальные — пустые. Причина: position:absolute
       выключает элемент из нормального потока, а фрагментация/разбивка на
       страницы CSS Paged Media в браузерах определена только для
       элементов В потоке — abspos-бокс не обязан (и на практике не
       умеет) повторяться на каждой печатной странице пачки, он "живёт"
       только в одном месте документа.

    Работающая версия: .label-page-inner остаётся в обычном потоке (НЕ
    position:absolute) — центрируется внутри .label-page флексбоксом.
    Поворот на 90° вокруг ЦЕНТРА исходного (width_mm×height_mm) блока даёт
    визуальный прямоугольник height_mm×width_mm, т.е. ровно размер
    .label-page (тот уже повёрнут/переставлен) — центры обоих совпадают
    благодаря флекс-центрированию, так что после поворота содержимое само
    попадает точно в границы страницы, без abspos и без translate-магии.
    Если на реальном принтере поворот окажется в другую сторону — заменить
    на rotate(-90deg) (transform-origin остаётся center, знак не влияет на
    то, что фигура всё равно впишется — только зеркалит направление)."""
    page_w, page_h = (height_mm, width_mm) if vertical else (width_mm, height_mm)
    rotation_css = "transform: rotate(90deg);" if vertical else ""
    return f"""
  @page {{ size: {page_w}mm {page_h}mm; margin: 0; }}
  * {{ box-sizing: border-box; }}
  html, body {{ margin: 0; padding: 0; font-family: "Calibri", "Segoe UI", Arial, sans-serif; color: {NAVY}; background: #fff; }}
  table.label-table {{ width: {width_mm}mm; height: {height_mm}mm; border-collapse: collapse; table-layout: fixed; border: 1px solid {BORDER}; border-radius: 4px; overflow: hidden; }}
  td.stripe-td {{ height: 100%; padding: 0; }}
  td.qr-td {{ vertical-align: middle; text-align: center; }}
  td.text-td {{ vertical-align: middle; text-align: left; padding: 2mm 3mm 2mm 1mm; overflow: hidden; word-break: break-word; }}
  .label-box {{ width: {width_mm}mm; height: {height_mm}mm; border: 1px solid {BORDER}; border-radius: 6px; overflow: hidden; display: block; position: relative; }}
  .content-box {{ padding: 2mm; text-align: center; }}
  .label-page {{ width: {page_w}mm; height: {page_h}mm; overflow: hidden; display: flex; align-items: center; justify-content: center; }}
  .label-page-inner {{ width: {width_mm}mm; height: {height_mm}mm; flex-shrink: 0; {rotation_css} }}
  .label-page + .label-page {{ page-break-before: always; }}
  @media print {{ .no-print {{ display: none; }} }}
"""


def render_label_html(
    data: LabelData,
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_WIDTH_MM,
    height_mm: int = DEFAULT_HEIGHT_MM,
    vertical: bool = False,
    page_format: PageFormat = "sticker",
) -> str:
    """HTML-версия этикетки — печатается через нативный window.print() браузера
    вместо PDF-blob. На планшетах (Android Chrome/Яндекс.Браузер) печать PDF,
    открытого как blob-URL, оказалась ненадёжной (система перехватывает blob
    как файл на скачивание в обход печати) — печать обычной HTML-страницы
    таких проблем не имеет, это стандартный путь через Print Service
    Framework Android. Для десктопного термопринтера (Codex G500) остаётся
    PDF-путь (render_label_pdf) — там раньше была обратная проблема с прямой
    печатью HTML.

    width_mm/height_mm здесь — уже РАЗРЕШЁННЫЙ физический размер страницы
    (см. resolve_page_format_dims, вызывается на уровне API до этой функции),
    page_format только переключает алгоритм раскладки полей внутри него."""
    fields = fields if fields is not None else DEFAULT_FIELDS
    markup = _label_markup(data, fields=fields, width_mm=width_mm, height_mm=height_mm, page_format=page_format)
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетка №{data.unit_id}</title>
<style>{_label_doc_styles(width_mm, height_mm, vertical)}</style>
</head>
<body>
  <div class="label-page"><div class="label-page-inner">{markup}</div></div>
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
    vertical: bool = False,
    page_format: PageFormat = "sticker",
) -> str:
    """Несколько этикеток одной HTML-страницей — печать очередью с планшета
    (аналог render_labels_pdf_batch для PDF-пути). Каждая этикетка на своей
    печатной странице через CSS page-break-before, без открытия N вкладок."""
    fields = fields if fields is not None else DEFAULT_FIELDS
    pages = "".join(
        f'<div class="label-page"><div class="label-page-inner">'
        f"{_label_markup(d, fields=fields, width_mm=width_mm, height_mm=height_mm, page_format=page_format)}"
        f"</div></div>"
        for d in items
    )
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетки ({len(items)})</title>
<style>{_label_doc_styles(width_mm, height_mm, vertical)}</style>
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


def _wrap_pdf_text(c: pdfcanvas.Canvas, text: str, font_name: str, size_pt: float, max_width_pt: float) -> list[str]:
    """Перенос строки по словам в пределах max_width_pt — тот же эффект,
    что word-break: break-word в HTML-версии этикетки (см.
    _label_doc_styles). PDF-путь рисовал каждое поле одной строкой без
    переноса (c.drawString), поэтому длинное значение просто уезжало за
    край этикетки и печаталось обрезанным на десктопе/термопринтере —
    HTML-путь на планшетах того не показывал, там перенос строк делает
    браузер сам по CSS (раздел обратной связи: "на планшете переносит, на
    компе обрезает"). Слово, которое само по себе шире max_width_pt, тоже
    режется — посимвольно, а не вылезает за край одним куском."""

    def fits(s: str) -> bool:
        return c.stringWidth(s, font_name, size_pt) <= max_width_pt

    lines: list[str] = []
    current = ""
    for word in text.split(" "):
        candidate = f"{current} {word}" if current else word
        if fits(candidate):
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ""
        if fits(word):
            current = word
            continue
        chunk = ""
        for ch in word:
            if fits(chunk + ch):
                chunk += ch
            else:
                if chunk:
                    lines.append(chunk)
                chunk = ch
        current = chunk
    if current:
        lines.append(current)
    return lines or [""]


def _wrap_pdf_fields(
    c: pdfcanvas.Canvas, rendered_fields: list[tuple[dict, str]], max_width_pt: float, *, heading_key: str
) -> list[tuple[dict, list[str]]]:
    """Общая точка переноса строк для всех трёх PDF-макетов (единица/полка/
    стеллаж) — heading_key задаёт, какое поле каждого макета рисуется
    заголовочным шрифтом (unit_id/location_code/rack_code)."""
    result: list[tuple[dict, list[str]]] = []
    for f, val in rendered_fields:
        size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
        font_name = _PDF_HEADING_FONT_BOLD if f["key"] == heading_key else (_PDF_BODY_FONT_BOLD if f.get("bold") else _PDF_BODY_FONT)
        result.append((f, _wrap_pdf_text(c, val, font_name, size_pt, max_width_pt)))
    return result


def _pdf_page_size(width_pt: float, height_pt: float, vertical: bool) -> tuple[float, float]:
    """Раздел про ориентацию печати — физическая страница PDF повёрнута
    (ширина/высота бумаги меняются местами), но координаты отрисовки
    остаются исходными (см. _apply_pdf_vertical_rotation ниже) — макет как
    был спроектирован под width_mm×height_mm, так и рисуется, самому коду
    отрисовки (_draw_label_page и т.п.) о повороте ничего знать не нужно."""
    return (height_pt, width_pt) if vertical else (width_pt, height_pt)


def _apply_pdf_vertical_rotation(c: pdfcanvas.Canvas, width_pt: float, height_pt: float, vertical: bool) -> None:
    """Настоящий поворот канваса на 90° (не просто смена местами ширины и
    высоты страницы, как было раньше) — раньше при печати "вертикально"
    страница физически становилась уже, но сам текст полей рисовался
    по-прежнему горизонтальной строкой, просто в более узком прямоугольнике
    ("размер верный, но печатает горизонтально"). После translate+rotate
    весь макет целиком (все поля, не только гигантское) поворачивается как
    единое целое — расположение полей друг относительно друга не меняется,
    меняется только то, что видно на бумаге при печати. c.showPage()
    сбрасывает трансформацию канваса — при печати нескольких этикеток в
    одном PDF (batch) вызывать заново после каждого showPage().

    Если после печати на реальном принтере поворот окажется в другую
    сторону (лицом наоборот) — единственное, что нужно поменять, это знак
    угла: c.rotate(-90) вместо c.rotate(90) (и translate — по высоте, а не
    по ширине)."""
    if not vertical:
        return
    c.translate(height_pt, 0)
    c.rotate(90)


def _clip_pdf_to_label_bounds(c: pdfcanvas.Canvas, width_pt: float, height_pt: float) -> None:
    """Обрезает всё нарисованное дальше по границе этикетки — тот же эффект,
    что overflow: hidden на .label-page в HTML-версии (_label_doc_styles).
    Без этого при переносе очень длинного значения (_wrap_pdf_text) лишние
    строки могли уехать вниз за пределы этикетки вместо аккуратной
    обрезки, как на планшете. Парная c.restoreState() — в конце
    соответствующей _draw_*_page."""
    c.saveState()
    p = c.beginPath()
    p.rect(0, 0, width_pt, height_pt)
    c.clipPath(p, stroke=0, fill=0)


def _pdf_text_block_height_mm(wrapped_fields: list[tuple[dict, list[str]]]) -> float:
    return sum(SIZE_PT.get(f.get("size", "sm"), 8) * 1.15 * 0.3528 * len(lines) for f, lines in wrapped_fields)


def _draw_pdf_text_lines(
    c: pdfcanvas.Canvas,
    wrapped_fields: list[tuple[dict, list[str]]],
    height_pt: float,
    left_mm: float,
    top_mm: float,
    max_width_mm: float,
    *,
    heading_key: str,
    center: bool = False,
) -> None:
    y = height_pt - top_mm * MM
    for f, lines in wrapped_fields:
        size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
        font_name = _PDF_HEADING_FONT_BOLD if f["key"] == heading_key else (_PDF_BODY_FONT_BOLD if f.get("bold") else _PDF_BODY_FONT)
        c.setFont(font_name, size_pt)
        c.setFillColor(HexColor(NAVY))
        for line in lines:
            y -= size_pt * 1.15
            if center:
                c.drawCentredString((left_mm + max_width_mm / 2) * MM, y, line)
            else:
                c.drawString(left_mm * MM, y, line)


def _fit_font_size_horizontal(
    text: str, font_name: str, max_width_pt: float, max_height_pt: float, *, min_size: float = 6.0, max_size: float = 400.0
) -> float:
    """Наибольший кегль (pt), при котором text целиком помещается в
    прямоугольник max_width×max_height одной строкой (раздел про огромный
    номер на этикетке места хранения — size="huge"). Бинарный поиск по
    pdfmetrics.stringWidth — той же метрике, что уже использует
    _wrap_pdf_text для PDF-пути; HTML-путь подставляет тот же посчитанный
    кегль обычным font-size, поэтому оба формата совпадают без
    headless-браузера для измерения текста в HTML."""
    text = text or " "
    lo, hi = min_size, max_size
    best = min_size
    while hi - lo > 0.5:
        mid = (lo + hi) / 2
        fits = pdfmetrics.stringWidth(text, font_name, mid) <= max_width_pt and mid * 1.15 <= max_height_pt
        if fits:
            best = mid
            lo = mid
        else:
            hi = mid
    return round(best, 1)


def _fit_font_size_vertical(
    text: str, font_name: str, max_width_pt: float, max_height_pt: float, *, min_size: float = 6.0, max_size: float = 400.0
) -> float:
    """Как _fit_font_size_horizontal, но для варианта "друг над другом" —
    по одному символу на строку (size="huge" + vertical=True). Ограничение
    по ширине — самый широкий из символов (не вся строка целиком), по
    высоте — все символы друг под другом с тем же множителем межстрочного
    интервала (1.15), что и у обычного текста этикетки."""
    chars = list(text) or [" "]
    lo, hi = min_size, max_size
    best = min_size
    while hi - lo > 0.5:
        mid = (lo + hi) / 2
        max_char_w = max(pdfmetrics.stringWidth(ch, font_name, mid) for ch in chars)
        total_h = mid * 1.15 * len(chars)
        if max_char_w <= max_width_pt and total_h <= max_height_pt:
            best = mid
            lo = mid
        else:
            hi = mid
    return round(best, 1)


def _giant_field_font_size_pt(text: str, font_name: str, *, width_mm: float, avail_height_mm: float, vertical: bool) -> float:
    """Общая точка для HTML и PDF пути — оба формата подставляют один и
    тот же посчитанный кегль, поэтому визуально совпадают."""
    fit = _fit_font_size_vertical if vertical else _fit_font_size_horizontal
    return fit(text, font_name, width_mm * MM, avail_height_mm * MM)


def _draw_giant_field_pdf(
    c: pdfcanvas.Canvas,
    text: str,
    font_name: str,
    *,
    height_pt: float,
    left_mm: float,
    top_mm: float,
    width_mm: float,
    avail_height_mm: float,
    vertical: bool,
) -> None:
    """Рисует одно поле максимально возможным кеглем, целиком заполняя
    прямоугольник (left_mm, top_mm)×(width_mm, avail_height_mm) — раздел
    про огромный номер на этикетке места хранения (size="huge"). top_mm —
    от верхнего края этикетки, тот же отсчёт, что у _draw_pdf_text_lines."""
    _register_pdf_fonts()
    c.setFillColor(HexColor(NAVY))
    top_y = height_pt - top_mm * MM
    avail_height_pt = avail_height_mm * MM
    center_x = (left_mm + width_mm / 2) * MM
    if vertical:
        chars = list(text) or [" "]
        size_pt = _fit_font_size_vertical(text, font_name, width_mm * MM, avail_height_pt)
        c.setFont(font_name, size_pt)
        line_h = size_pt * 1.15
        total_h = line_h * len(chars)
        cy = top_y - (avail_height_pt - total_h) / 2
        for ch in chars:
            cy -= line_h
            c.drawCentredString(center_x, cy + line_h * 0.18, ch)
    else:
        size_pt = _fit_font_size_horizontal(text, font_name, width_mm * MM, avail_height_pt)
        c.setFont(font_name, size_pt)
        cy = top_y - (avail_height_pt - size_pt) / 2 - size_pt * 0.82
        c.drawCentredString(center_x, cy, text or "")


def _giant_field_html(text: str, font_name: str, *, width_mm: float, avail_height_mm: float, vertical: bool, font_family_css: str) -> str:
    """HTML-эквивалент _draw_giant_field_pdf — тот же посчитанный кегль
    (_giant_field_font_size_pt), просто подставленный как font-size в CSS
    вместо рисования на канвасе. HTML-путь обычно не нуждается в реально
    зарегистрированных файлах шрифта (браузер сам умеет рисовать текст по
    имени font-family) — но измерение через pdfmetrics.stringWidth ниже
    нуждается, поэтому регистрируем здесь на всякий случай (дёшево при
    повторном вызове — флаг _PDF_FONTS_REGISTERED)."""
    _register_pdf_fonts()
    if vertical:
        chars = list(text) or [" "]
        size_pt = _fit_font_size_vertical(text, font_name, width_mm * MM, avail_height_mm * MM)
        lines = "".join(f'<div style="line-height:1.15;">{ch}</div>' for ch in chars)
        return (
            f'<div style="width:{width_mm}mm; height:{avail_height_mm}mm; display:flex; flex-direction:column; '
            f'align-items:center; justify-content:center; font-size:{size_pt}pt; font-weight:bold; {font_family_css} color:{NAVY};">'
            f"{lines}</div>"
        )
    size_pt = _fit_font_size_horizontal(text, font_name, width_mm * MM, avail_height_mm * MM)
    return (
        f'<div style="width:{width_mm}mm; height:{avail_height_mm}mm; display:flex; align-items:center; '
        f'justify-content:center; font-size:{size_pt}pt; font-weight:bold; {font_family_css} color:{NAVY}; '
        f'white-space:nowrap; line-height:1.15;">{text}</div>'
    )


def _draw_autofit_fields_pdf(
    c: pdfcanvas.Canvas,
    rendered_fields: list[tuple[dict, str]],
    *,
    height_pt: float,
    left_mm: float,
    top_mm: float,
    width_mm: float,
    avail_height_mm: float,
    heading_key: str,
) -> None:
    """Формат А4 для обычных (не "huge") полей — вместо мелкого
    фиксированного SIZE_PT (потерялся бы на большом листе) каждое поле
    получает свою долю доступной высоты (SIZE_WEIGHT) и печатается
    максимально возможным кеглем в этой доле — переиспользует тот же
    _draw_giant_field_pdf, что уже даёт size="huge" на обычной наклейке,
    просто применяет его по очереди к каждому полю, а не к одному."""
    if not rendered_fields:
        return
    total_weight = sum(SIZE_WEIGHT.get(f.get("size", "sm"), 1.0) for f, _ in rendered_fields)
    y_top = top_mm
    for f, val in rendered_fields:
        share_mm = avail_height_mm * SIZE_WEIGHT.get(f.get("size", "sm"), 1.0) / total_weight
        font_name = _PDF_HEADING_FONT_BOLD if f["key"] == heading_key else (_PDF_BODY_FONT_BOLD if f.get("bold") else _PDF_BODY_FONT)
        _draw_giant_field_pdf(
            c, val, font_name, height_pt=height_pt, left_mm=left_mm, top_mm=y_top,
            width_mm=width_mm, avail_height_mm=share_mm, vertical=False,
        )
        y_top += share_mm


def _autofit_fields_html(
    rendered_fields: list[tuple[dict, str]], *, width_mm: float, avail_height_mm: float, heading_key: str
) -> str:
    """HTML-эквивалент _draw_autofit_fields_pdf — та же логика долей,
    просто через _giant_field_html вместо рисования на канвасе."""
    if not rendered_fields:
        return ""
    total_weight = sum(SIZE_WEIGHT.get(f.get("size", "sm"), 1.0) for f, _ in rendered_fields)
    parts = []
    for f, val in rendered_fields:
        share_mm = avail_height_mm * SIZE_WEIGHT.get(f.get("size", "sm"), 1.0) / total_weight
        is_heading = f["key"] == heading_key
        font_name = _PDF_HEADING_FONT_BOLD if is_heading else _PDF_BODY_FONT
        font_family_css = 'font-family:"Cambria", Georgia, serif;' if is_heading else ""
        parts.append(
            _giant_field_html(val, font_name, width_mm=width_mm, avail_height_mm=share_mm, vertical=False, font_family_css=font_family_css)
        )
    return f'<div style="display:flex; flex-direction:column; width:{width_mm}mm; height:{avail_height_mm}mm;">' + "".join(parts) + "</div>"


def _draw_label_page(
    c: pdfcanvas.Canvas,
    data: LabelData,
    fields: list[dict],
    width_mm: int,
    height_mm: int,
    page_format: PageFormat = "sticker",
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
    giant_field = next((f for f in fields if f.get("size") == "huge"), None)

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        key = f["key"]
        if key in ("status_stripe", "qr") or f is giant_field:
            continue
        val = render_field_value(data, key, show_label=f.get("show_label", True))
        if val:
            rendered_fields.append((f, val))

    width_pt, height_pt = width_mm * MM, height_mm * MM
    c.setStrokeColor(HexColor(BORDER))
    c.setLineWidth(0.5)
    c.roundRect(0.3 * MM, 0.3 * MM, width_pt - 0.6 * MM, height_pt - 0.6 * MM, 1.5 * MM, stroke=1, fill=0)
    _clip_pdf_to_label_bounds(c, width_pt, height_pt)

    qr_reader = ImageReader(BytesIO(qr_png_bytes(str(data.unit_id)))) if has_qr else None
    giant_vertical = bool(giant_field.get("vertical")) if giant_field is not None else False

    if is_landscape:
        stripe_w_mm = 4 if has_stripe else 0
        if has_stripe:
            c.setFillColor(HexColor(color))
            c.rect(0, 0, stripe_w_mm * MM, height_pt, fill=1, stroke=0)

        qr_col_w_mm = 0.0
        if has_qr and qr_reader is not None:
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=True)
            qr_col_w_mm = qr_size_mm + 4
            qr_x_mm = stripe_w_mm + (qr_col_w_mm - qr_size_mm) / 2
            qr_y_mm = (height_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, qr_y_mm * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")

        text_x_mm = stripe_w_mm + qr_col_w_mm + 2
        text_w_mm = max(width_mm - text_x_mm - 2, 5)
        if giant_field is not None:
            giant_val = render_field_value(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not giant_vertical) or ""
            _draw_giant_field_pdf(
                c, giant_val, _PDF_HEADING_FONT_BOLD, height_pt=height_pt, left_mm=text_x_mm, top_mm=1,
                width_mm=text_w_mm, avail_height_mm=height_mm - 2, vertical=giant_vertical,
            )
        elif page_format == "a4":
            _draw_autofit_fields_pdf(
                c, rendered_fields, height_pt=height_pt, left_mm=text_x_mm, top_mm=1,
                width_mm=text_w_mm, avail_height_mm=height_mm - 2, heading_key="unit_id",
            )
        else:
            wrapped = _wrap_pdf_fields(c, rendered_fields, text_w_mm * MM, heading_key="unit_id")
            top_mm = max((height_mm - _pdf_text_block_height_mm(wrapped)) / 2, 2)
            _draw_pdf_text_lines(c, wrapped, height_pt, text_x_mm, top_mm, text_w_mm, heading_key="unit_id")
    else:
        top_mm = 3.0
        if has_stripe:
            c.setFillColor(HexColor(color))
            c.rect(0, height_pt - 5 * MM, width_pt, 5 * MM, fill=1, stroke=0)
            top_mm = 8.0
        if has_qr and qr_reader is not None:
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=False, giant=giant_field is not None)
            qr_x_mm = (width_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, height_pt - (top_mm + qr_size_mm) * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
            top_mm += qr_size_mm + 2
        text_w_mm = max(width_mm - 8, 5)
        if giant_field is not None:
            giant_val = render_field_value(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not giant_vertical) or ""
            _draw_giant_field_pdf(
                c, giant_val, _PDF_HEADING_FONT_BOLD, height_pt=height_pt, left_mm=4, top_mm=top_mm,
                width_mm=text_w_mm, avail_height_mm=height_mm - top_mm - 2, vertical=giant_vertical,
            )
        elif page_format == "a4":
            _draw_autofit_fields_pdf(
                c, rendered_fields, height_pt=height_pt, left_mm=4, top_mm=top_mm,
                width_mm=text_w_mm, avail_height_mm=height_mm - top_mm - 2, heading_key="unit_id",
            )
        else:
            wrapped = _wrap_pdf_fields(c, rendered_fields, text_w_mm * MM, heading_key="unit_id")
            _draw_pdf_text_lines(c, wrapped, height_pt, 4, top_mm, text_w_mm, heading_key="unit_id", center=True)
    c.restoreState()


def render_label_pdf(
    data: LabelData,
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_WIDTH_MM,
    height_mm: int = DEFAULT_HEIGHT_MM,
    vertical: bool = False,
    page_format: PageFormat = "sticker",
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
    (который остаётся для просмотра в браузере).

    width_mm/height_mm — уже разрешённый физический размер страницы (см.
    resolve_page_format_dims), page_format переключает алгоритм раскладки."""
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=_pdf_page_size(width_pt, height_pt, vertical))
    _apply_pdf_vertical_rotation(c, width_pt, height_pt, vertical)
    _draw_label_page(c, data, fields, width_mm, height_mm, page_format=page_format)
    c.showPage()
    c.save()
    return buf.getvalue()


def render_labels_pdf_batch(
    items: list[LabelData],
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_WIDTH_MM,
    height_mm: int = DEFAULT_HEIGHT_MM,
    vertical: bool = False,
    page_format: PageFormat = "sticker",
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
    c = pdfcanvas.Canvas(buf, pagesize=_pdf_page_size(width_pt, height_pt, vertical))
    for data in items:
        _apply_pdf_vertical_rotation(c, width_pt, height_pt, vertical)
        _draw_label_page(c, data, fields, width_mm, height_mm, page_format=page_format)
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
    is_strip=False,
    width_mm=1400,
    length_m=214,
    task_name="Дверь царговая, Прованс",
    part_name="Стоевая",
)

# Раздел про отдельные макеты для рулонов/штрипсов — превью вида "strip" на
# отдельных синтетических данных (родитель + is_strip=True), чтобы
# цветной индикатор и parent_ref на превью выглядели так же, как у
# реального штрипса.
PREVIEW_DATA_STRIP = LabelData(
    unit_id=12346,
    material="ПВХ плёнка",
    color="Дуб беленый",
    thickness_mm=0.35,
    manufacturer="Классен",
    upd_number="УПД-000123",
    pallet_number="4",
    received_date=date.today(),
    supplier_code="KL-3391",
    native_width_mm=1400,
    parent_id=12345,
    is_strip=True,
    width_mm=150,
    length_m=214,
    task_name="Дверь царговая, Прованс",
    part_name="Стоевая",
)

# Раздел про макет для этапа резки/выдачи (kind="cutting_issue") — тот же
# состав, что у DEFAULT_FIELDS, плюс "Назначение" сразу в макете по
# умолчанию (раньше дописывалось поверх сохранённого макета через
# extra_fields только в двух сценариях печати — теперь это отдельный
# полноценный вид со своим макетом, где поле нужно всегда).
DEFAULT_FIELDS_CUTTING_ISSUE: list[dict] = DEFAULT_FIELDS + [
    {"key": "task_assignment", "size": "md", "bold": True},
]


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
    "location_code": {"label": "Код места (полка)", "kind": "text", "has_caption": False},
    "warehouse_name": {"label": "Склад", "kind": "text"},
    "rack_type": {"label": "Тип стеллажа", "kind": "text"},
    "shelf": {"label": "Номер полки", "kind": "text"},
    "storage_rules": {"label": "Правила хранения", "kind": "text", "has_caption": False},
}


@dataclass(frozen=True)
class ShelfLabelData:
    location_code: str
    warehouse_name: str
    rack_type_label: str
    shelf: int
    storage_rules_text: str | None


def render_field_value_shelf(data: ShelfLabelData, key: str, *, show_label: bool = True) -> str | None:
    """Как render_field_value для рулона: location_code/storage_rules — уже
    сами по себе понятные значения (как unit_id "№ 42"), без отдельной
    подписи — show_label для них не действует."""
    if key == "location_code":
        return data.location_code
    if key == "warehouse_name":
        return f"Склад: {data.warehouse_name}" if show_label else data.warehouse_name
    if key == "rack_type":
        return f"Тип: {data.rack_type_label}" if show_label else data.rack_type_label
    if key == "shelf":
        value = str(data.shelf)
        return f"Полка: {value}" if show_label else value
    if key == "storage_rules":
        return data.storage_rules_text
    return None


def _shelf_label_markup(data: ShelfLabelData, *, fields: list[dict], width_mm: int, height_mm: int, page_format: PageFormat = "sticker") -> str:
    # Раньше HTML-путь не нуждался в реально зарегистрированных файлах
    # шрифта (браузер сам рисует по имени font-family) — но giant_field
    # ниже читает _PDF_HEADING_FONT_BOLD и меряет текст через pdfmetrics,
    # которому кириллица без регистрации TTF (только base14 Helvetica)
    # не по зубам. Регистрируем здесь же, до первого чтения глобала.
    _register_pdf_fonts()
    qr_src = qr_data_uri(data.location_code)
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)

    # Раздел про огромный номер на этикетке места хранения — size="huge"
    # заменяет собой весь текстовый блок (остальные текстовые поля не
    # поместились бы рядом с текстом на всю этикетку, поэтому просто не
    # печатаются; предупреждение об этом — в конструкторе макета). Первое
    # такое поле в списке побеждает, если их вдруг несколько.
    giant_field = next((f for f in fields if f.get("size") == "huge"), None)
    if giant_field is not None:
        vertical = bool(giant_field.get("vertical"))
        giant_val = render_field_value_shelf(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not vertical) or ""
        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=is_landscape, giant=True)
        if is_landscape:
            qr_html = (
                f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
                f'<img src="{qr_src}" alt="QR {data.location_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</td>'
                if has_qr
                else ""
            )
            text_w_mm = max(width_mm - (qr_size_mm + 4 if has_qr else 0) - 2, 5)
            giant_html = _giant_field_html(
                giant_val, _PDF_HEADING_FONT_BOLD, width_mm=text_w_mm, avail_height_mm=height_mm - 2, vertical=vertical,
                font_family_css='font-family:"Cambria", Georgia, serif;',
            )
            return f"""<table class="label-table">
    <tr>
      {qr_html}
      <td class="text-td" style="text-align:center;">
        {giant_html}
      </td>
    </tr>
  </table>"""
        else:
            qr_html = (
                f'<div style="margin: 1mm 0; text-align:center;">'
                f'<img src="{qr_src}" alt="QR {data.location_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</div>'
                if has_qr
                else ""
            )
            avail_height_mm = height_mm - (qr_size_mm + 2 if has_qr else 2)
            giant_html = _giant_field_html(
                giant_val, _PDF_HEADING_FONT_BOLD, width_mm=width_mm - 4, avail_height_mm=avail_height_mm, vertical=vertical,
                font_family_css='font-family:"Cambria", Georgia, serif;',
            )
            return f"""<div class="label-box">
    {qr_html}
    <div class="content-box" style="padding:0;">
      {giant_html}
    </div>
  </div>"""

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr":
            continue
        val = render_field_value_shelf(data, f["key"], show_label=f.get("show_label", True))
        if val:
            rendered_fields.append((f, val))

    if is_landscape:
        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=True)
        qr_html = (
            f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
            f'<img src="{qr_src}" alt="QR {data.location_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</td>'
            if has_qr
            else ""
        )
        text_w_mm = max(width_mm - (qr_size_mm + 4 if has_qr else 0) - 2, 5)
        if page_format == "a4":
            text_html = _autofit_fields_html(rendered_fields, width_mm=text_w_mm, avail_height_mm=height_mm - 2, heading_key="location_code")
        else:
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
            text_html = "".join(text_html_items)
        return f"""<table class="label-table">
    <tr>
      {qr_html}
      <td class="text-td">
        {text_html}
      </td>
    </tr>
  </table>"""
    else:
        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=False)
        if page_format == "a4":
            qr_html = (
                f'<div style="margin: 1mm 0; text-align:center;">'
                f'<img src="{qr_src}" alt="QR {data.location_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</div>'
                if has_qr
                else ""
            )
            avail_height_mm = height_mm - (qr_size_mm + 2 if has_qr else 2)
            body_html = _autofit_fields_html(rendered_fields, width_mm=width_mm - 4, avail_height_mm=avail_height_mm, heading_key="location_code")
            return f"""<div class="label-box">
    {qr_html}
    <div class="content-box">
      {body_html}
    </div>
  </div>"""
        body_items = []
        for f in fields:
            if f["key"] == "qr":
                body_items.append(
                    f'<div style="margin: 1mm 0; text-align:center;">'
                    f'<img src="{qr_src}" alt="QR {data.location_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                    f'</div>'
                )
                continue
            val = render_field_value_shelf(data, f["key"], show_label=f.get("show_label", True))
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
    data: ShelfLabelData,
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_SHELF_WIDTH_MM,
    height_mm: int = DEFAULT_SHELF_HEIGHT_MM,
    vertical: bool = False,
    page_format: PageFormat = "sticker",
) -> str:
    fields = fields if fields is not None else DEFAULT_FIELDS_SHELF
    markup = _shelf_label_markup(data, fields=fields, width_mm=width_mm, height_mm=height_mm, page_format=page_format)
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетка {data.location_code}</title>
<style>{_label_doc_styles(width_mm, height_mm, vertical)}</style>
</head>
<body>
  <div class="label-page"><div class="label-page-inner">{markup}</div></div>
  <div class="no-print" style="margin-top: 8px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


def render_shelf_labels_html_batch(
    items: list[ShelfLabelData],
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_SHELF_WIDTH_MM,
    height_mm: int = DEFAULT_SHELF_HEIGHT_MM,
    vertical: bool = False,
    page_format: PageFormat = "sticker",
) -> str:
    fields = fields if fields is not None else DEFAULT_FIELDS_SHELF
    pages = "".join(
        f'<div class="label-page"><div class="label-page-inner">'
        f"{_shelf_label_markup(d, fields=fields, width_mm=width_mm, height_mm=height_mm, page_format=page_format)}"
        f"</div></div>"
        for d in items
    )
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетки мест хранения ({len(items)})</title>
<style>{_label_doc_styles(width_mm, height_mm, vertical)}</style>
</head>
<body>
  {pages}
  <div class="no-print" style="margin-top: 8px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


def _draw_shelf_label_page(
    c: pdfcanvas.Canvas, data: ShelfLabelData, fields: list[dict], width_mm: int, height_mm: int, page_format: PageFormat = "sticker"
) -> None:
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)
    giant_field = next((f for f in fields if f.get("size") == "huge"), None)
    giant_vertical = bool(giant_field.get("vertical")) if giant_field is not None else False

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr" or f is giant_field:
            continue
        val = render_field_value_shelf(data, f["key"], show_label=f.get("show_label", True))
        if val:
            rendered_fields.append((f, val))

    width_pt, height_pt = width_mm * MM, height_mm * MM
    c.setStrokeColor(HexColor(BORDER))
    c.setLineWidth(0.5)
    c.roundRect(0.3 * MM, 0.3 * MM, width_pt - 0.6 * MM, height_pt - 0.6 * MM, 1.5 * MM, stroke=1, fill=0)
    _clip_pdf_to_label_bounds(c, width_pt, height_pt)

    qr_reader = ImageReader(BytesIO(qr_png_bytes(data.location_code))) if has_qr else None

    if is_landscape:
        qr_col_w_mm = 0.0
        if has_qr and qr_reader is not None:
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=True)
            qr_col_w_mm = qr_size_mm + 4
            qr_x_mm = (qr_col_w_mm - qr_size_mm) / 2
            qr_y_mm = (height_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, qr_y_mm * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
        text_x_mm = qr_col_w_mm + 2
        text_w_mm = max(width_mm - text_x_mm - 2, 5)
        if giant_field is not None:
            giant_val = render_field_value_shelf(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not giant_vertical) or ""
            _draw_giant_field_pdf(
                c, giant_val, _PDF_HEADING_FONT_BOLD, height_pt=height_pt, left_mm=text_x_mm, top_mm=1,
                width_mm=text_w_mm, avail_height_mm=height_mm - 2, vertical=giant_vertical,
            )
        elif page_format == "a4":
            _draw_autofit_fields_pdf(
                c, rendered_fields, height_pt=height_pt, left_mm=text_x_mm, top_mm=1,
                width_mm=text_w_mm, avail_height_mm=height_mm - 2, heading_key="location_code",
            )
        else:
            wrapped = _wrap_pdf_fields(c, rendered_fields, text_w_mm * MM, heading_key="location_code")
            top_mm = max((height_mm - _pdf_text_block_height_mm(wrapped)) / 2, 2)
            _draw_pdf_text_lines(c, wrapped, height_pt, text_x_mm, top_mm, text_w_mm, heading_key="location_code")
    else:
        top_mm = 3.0
        if has_qr and qr_reader is not None:
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=False, giant=giant_field is not None)
            qr_x_mm = (width_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, height_pt - (top_mm + qr_size_mm) * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
            top_mm += qr_size_mm + 2
        text_w_mm = max(width_mm - 8, 5)
        if giant_field is not None:
            giant_val = render_field_value_shelf(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not giant_vertical) or ""
            _draw_giant_field_pdf(
                c, giant_val, _PDF_HEADING_FONT_BOLD, height_pt=height_pt, left_mm=4, top_mm=top_mm,
                width_mm=text_w_mm, avail_height_mm=height_mm - top_mm - 2, vertical=giant_vertical,
            )
        elif page_format == "a4":
            _draw_autofit_fields_pdf(
                c, rendered_fields, height_pt=height_pt, left_mm=4, top_mm=top_mm,
                width_mm=text_w_mm, avail_height_mm=height_mm - top_mm - 2, heading_key="location_code",
            )
        else:
            wrapped = _wrap_pdf_fields(c, rendered_fields, text_w_mm * MM, heading_key="location_code")
            _draw_pdf_text_lines(c, wrapped, height_pt, 4, top_mm, text_w_mm, heading_key="location_code", center=True)
    c.restoreState()


def render_shelf_label_pdf(
    data: ShelfLabelData,
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_SHELF_WIDTH_MM,
    height_mm: int = DEFAULT_SHELF_HEIGHT_MM,
    vertical: bool = False,
    page_format: PageFormat = "sticker",
) -> bytes:
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS_SHELF
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=_pdf_page_size(width_pt, height_pt, vertical))
    _apply_pdf_vertical_rotation(c, width_pt, height_pt, vertical)
    _draw_shelf_label_page(c, data, fields, width_mm, height_mm, page_format=page_format)
    c.showPage()
    c.save()
    return buf.getvalue()


def render_shelf_labels_pdf_batch(
    items: list[ShelfLabelData],
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_SHELF_WIDTH_MM,
    height_mm: int = DEFAULT_SHELF_HEIGHT_MM,
    vertical: bool = False,
    page_format: PageFormat = "sticker",
) -> bytes:
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS_SHELF
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=_pdf_page_size(width_pt, height_pt, vertical))
    for data in items:
        _apply_pdf_vertical_rotation(c, width_pt, height_pt, vertical)
        _draw_shelf_label_page(c, data, fields, width_mm, height_mm, page_format=page_format)
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


# ─── Этикетка стеллажа целиком (kind="rack_roll"/"rack_strip") ───
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
    "rack_code": {"label": "Код стеллажа", "kind": "text", "has_caption": False},
    "warehouse_name": {"label": "Склад", "kind": "text"},
    "rack_type": {"label": "Тип стеллажа", "kind": "text"},
    "shelf_count": {"label": "Число полок", "kind": "text"},
    "storage_rules": {"label": "Правила хранения", "kind": "text", "has_caption": False},
}


@dataclass(frozen=True)
class RackLabelData:
    rack_code: str
    warehouse_name: str
    rack_type_label: str
    shelf_count: int
    storage_rules_text: str | None


def render_field_value_rack(data: RackLabelData, key: str, *, show_label: bool = True) -> str | None:
    """rack_code/storage_rules — без подписи (как location_code/unit_id у
    соседних макетов), show_label для них не действует; storage_rules —
    уже готовая сводка всех правил стеллажа или None, если правил нет
    (поле тогда просто пропускается, как parent_ref у единицы без
    родителя)."""
    if key == "rack_code":
        return data.rack_code
    if key == "warehouse_name":
        return f"Склад: {data.warehouse_name}" if show_label else data.warehouse_name
    if key == "rack_type":
        return f"Тип: {data.rack_type_label}" if show_label else data.rack_type_label
    if key == "shelf_count":
        value = str(data.shelf_count)
        return f"Полок: {value}" if show_label else value
    if key == "storage_rules":
        return data.storage_rules_text
    return None


def _rack_label_markup(data: RackLabelData, *, fields: list[dict], width_mm: int, height_mm: int, page_format: PageFormat = "sticker") -> str:
    _register_pdf_fonts()
    qr_src = qr_data_uri(data.rack_code)
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)

    giant_field = next((f for f in fields if f.get("size") == "huge"), None)
    if giant_field is not None:
        vertical = bool(giant_field.get("vertical"))
        giant_val = render_field_value_rack(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not vertical) or ""
        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=is_landscape, giant=True)
        if is_landscape:
            qr_html = (
                f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
                f'<img src="{qr_src}" alt="QR {data.rack_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</td>'
                if has_qr
                else ""
            )
            text_w_mm = max(width_mm - (qr_size_mm + 4 if has_qr else 0) - 2, 5)
            giant_html = _giant_field_html(
                giant_val, _PDF_HEADING_FONT_BOLD, width_mm=text_w_mm, avail_height_mm=height_mm - 2, vertical=vertical,
                font_family_css='font-family:"Cambria", Georgia, serif;',
            )
            return f"""<table class="label-table">
    <tr>
      {qr_html}
      <td class="text-td" style="text-align:center;">
        {giant_html}
      </td>
    </tr>
  </table>"""
        else:
            qr_html = (
                f'<div style="margin: 1mm 0; text-align:center;">'
                f'<img src="{qr_src}" alt="QR {data.rack_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</div>'
                if has_qr
                else ""
            )
            avail_height_mm = height_mm - (qr_size_mm + 2 if has_qr else 2)
            giant_html = _giant_field_html(
                giant_val, _PDF_HEADING_FONT_BOLD, width_mm=width_mm - 4, avail_height_mm=avail_height_mm, vertical=vertical,
                font_family_css='font-family:"Cambria", Georgia, serif;',
            )
            return f"""<div class="label-box">
    {qr_html}
    <div class="content-box" style="padding:0;">
      {giant_html}
    </div>
  </div>"""

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr":
            continue
        val = render_field_value_rack(data, f["key"], show_label=f.get("show_label", True))
        if val:
            rendered_fields.append((f, val))

    if is_landscape:
        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=True)
        qr_html = (
            f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
            f'<img src="{qr_src}" alt="QR {data.rack_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</td>'
            if has_qr
            else ""
        )
        text_w_mm = max(width_mm - (qr_size_mm + 4 if has_qr else 0) - 2, 5)
        if page_format == "a4":
            text_html = _autofit_fields_html(rendered_fields, width_mm=text_w_mm, avail_height_mm=height_mm - 2, heading_key="rack_code")
        else:
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
            text_html = "".join(text_html_items)
        return f"""<table class="label-table">
    <tr>
      {qr_html}
      <td class="text-td">
        {text_html}
      </td>
    </tr>
  </table>"""
    else:
        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=False)
        if page_format == "a4":
            qr_html = (
                f'<div style="margin: 1mm 0; text-align:center;">'
                f'<img src="{qr_src}" alt="QR {data.rack_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</div>'
                if has_qr
                else ""
            )
            avail_height_mm = height_mm - (qr_size_mm + 2 if has_qr else 2)
            body_html = _autofit_fields_html(rendered_fields, width_mm=width_mm - 4, avail_height_mm=avail_height_mm, heading_key="rack_code")
            return f"""<div class="label-box">
    {qr_html}
    <div class="content-box">
      {body_html}
    </div>
  </div>"""
        body_items = []
        for f in fields:
            if f["key"] == "qr":
                body_items.append(
                    f'<div style="margin: 1mm 0; text-align:center;">'
                    f'<img src="{qr_src}" alt="QR {data.rack_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                    f'</div>'
                )
                continue
            val = render_field_value_rack(data, f["key"], show_label=f.get("show_label", True))
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
    data: RackLabelData,
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_RACK_WIDTH_MM,
    height_mm: int = DEFAULT_RACK_HEIGHT_MM,
    vertical: bool = False,
    page_format: PageFormat = "sticker",
) -> str:
    fields = fields if fields is not None else DEFAULT_FIELDS_RACK
    markup = _rack_label_markup(data, fields=fields, width_mm=width_mm, height_mm=height_mm, page_format=page_format)
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетка стеллажа {data.rack_code}</title>
<style>{_label_doc_styles(width_mm, height_mm, vertical)}</style>
</head>
<body>
  <div class="label-page"><div class="label-page-inner">{markup}</div></div>
  <div class="no-print" style="margin-top: 8px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


def _draw_rack_label_page(
    c: pdfcanvas.Canvas, data: RackLabelData, fields: list[dict], width_mm: int, height_mm: int, page_format: PageFormat = "sticker"
) -> None:
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)
    giant_field = next((f for f in fields if f.get("size") == "huge"), None)
    giant_vertical = bool(giant_field.get("vertical")) if giant_field is not None else False

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr" or f is giant_field:
            continue
        val = render_field_value_rack(data, f["key"], show_label=f.get("show_label", True))
        if val:
            rendered_fields.append((f, val))

    width_pt, height_pt = width_mm * MM, height_mm * MM
    c.setStrokeColor(HexColor(BORDER))
    c.setLineWidth(0.5)
    c.roundRect(0.3 * MM, 0.3 * MM, width_pt - 0.6 * MM, height_pt - 0.6 * MM, 1.5 * MM, stroke=1, fill=0)
    _clip_pdf_to_label_bounds(c, width_pt, height_pt)

    qr_reader = ImageReader(BytesIO(qr_png_bytes(data.rack_code))) if has_qr else None

    if is_landscape:
        qr_col_w_mm = 0.0
        if has_qr and qr_reader is not None:
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=True)
            qr_col_w_mm = qr_size_mm + 4
            qr_x_mm = (qr_col_w_mm - qr_size_mm) / 2
            qr_y_mm = (height_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, qr_y_mm * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
        text_x_mm = qr_col_w_mm + 2
        text_w_mm = max(width_mm - text_x_mm - 2, 5)
        if giant_field is not None:
            giant_val = render_field_value_rack(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not giant_vertical) or ""
            _draw_giant_field_pdf(
                c, giant_val, _PDF_HEADING_FONT_BOLD, height_pt=height_pt, left_mm=text_x_mm, top_mm=1,
                width_mm=text_w_mm, avail_height_mm=height_mm - 2, vertical=giant_vertical,
            )
        elif page_format == "a4":
            _draw_autofit_fields_pdf(
                c, rendered_fields, height_pt=height_pt, left_mm=text_x_mm, top_mm=1,
                width_mm=text_w_mm, avail_height_mm=height_mm - 2, heading_key="rack_code",
            )
        else:
            wrapped = _wrap_pdf_fields(c, rendered_fields, text_w_mm * MM, heading_key="rack_code")
            top_mm = max((height_mm - _pdf_text_block_height_mm(wrapped)) / 2, 2)
            _draw_pdf_text_lines(c, wrapped, height_pt, text_x_mm, top_mm, text_w_mm, heading_key="rack_code")
    else:
        top_mm = 3.0
        if has_qr and qr_reader is not None:
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=False, giant=giant_field is not None)
            qr_x_mm = (width_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, height_pt - (top_mm + qr_size_mm) * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
            top_mm += qr_size_mm + 2
        text_w_mm = max(width_mm - 8, 5)
        if giant_field is not None:
            giant_val = render_field_value_rack(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not giant_vertical) or ""
            _draw_giant_field_pdf(
                c, giant_val, _PDF_HEADING_FONT_BOLD, height_pt=height_pt, left_mm=4, top_mm=top_mm,
                width_mm=text_w_mm, avail_height_mm=height_mm - top_mm - 2, vertical=giant_vertical,
            )
        elif page_format == "a4":
            _draw_autofit_fields_pdf(
                c, rendered_fields, height_pt=height_pt, left_mm=4, top_mm=top_mm,
                width_mm=text_w_mm, avail_height_mm=height_mm - top_mm - 2, heading_key="rack_code",
            )
        else:
            wrapped = _wrap_pdf_fields(c, rendered_fields, text_w_mm * MM, heading_key="rack_code")
            _draw_pdf_text_lines(c, wrapped, height_pt, 4, top_mm, text_w_mm, heading_key="rack_code", center=True)
    c.restoreState()


def render_rack_label_pdf(
    data: RackLabelData,
    *,
    fields: list[dict] | None = None,
    width_mm: int = DEFAULT_RACK_WIDTH_MM,
    height_mm: int = DEFAULT_RACK_HEIGHT_MM,
    vertical: bool = False,
    page_format: PageFormat = "sticker",
) -> bytes:
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS_RACK
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=_pdf_page_size(width_pt, height_pt, vertical))
    _apply_pdf_vertical_rotation(c, width_pt, height_pt, vertical)
    _draw_rack_label_page(c, data, fields, width_mm, height_mm, page_format=page_format)
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


# ─── Этикетки п/ф (партия/стеллаж/полка) ───────────────────────────────
# Раздел про QR-этикетки п/ф — тот же принцип, что у трёх макетов выше
# (отдельные функции рендера на своих данных, не переиспользование чужих
# ORM-объектов), только под PartUnit/PartRack. QR-полезная нагрузка:
# партия — "ПФ"+id (не голое число — коллидировало бы с id единицы
# плёнки в общем сканере), стеллаж/полка — голый код/location_code.

DEFAULT_PF_UNIT_WIDTH_MM = 100
DEFAULT_PF_UNIT_HEIGHT_MM = 40

DEFAULT_FIELDS_PF_UNIT: list[dict] = [
    {"key": "qr", "size": "md", "bold": False},
    {"key": "batch_id", "size": "lg", "bold": True},
    {"key": "part_name", "size": "md", "bold": True},
    {"key": "quantity_pieces", "size": "md", "bold": False},
    {"key": "stage_name", "size": "sm", "bold": False},
    {"key": "area", "size": "sm", "bold": False},
    {"key": "task_name", "size": "sm", "bold": False},
]

FIELD_META_PF_UNIT: dict[str, dict] = {
    "qr": {"label": "QR-код", "kind": "image"},
    "batch_id": {"label": "№ партии", "kind": "text", "has_caption": False},
    "part_name": {"label": "Деталь", "kind": "text"},
    "quantity_pieces": {"label": "Количество, шт", "kind": "text"},
    "stage_name": {"label": "Этап", "kind": "text"},
    "area": {"label": "Участок", "kind": "text"},
    "task_name": {"label": "Задание", "kind": "text"},
    "note": {"label": "Заметка", "kind": "text"},
}


@dataclass(frozen=True)
class PartLabelData:
    batch_id: int
    part_name: str
    quantity_pieces: float
    stage_name: str
    area: str | None
    task_name: str | None
    note: str | None


def part_label_data_from_unit(unit, db=None) -> "PartLabelData":  # unit: app.models.part_units.PartUnit
    """Плоский снимок партии п/ф для печати — тот же приём, что и
    label_data_from_unit у плёнки (без ORM внутри рендер-функций).

    В отличие от MaterialUnit, у PartUnit нет relationship
    production_task_line (только голый production_task_line_id) — задание
    подгружается отдельным запросом через переданную сессию db, если оно
    вообще есть (безадресная партия — task_name остаётся None)."""
    task_name = None
    if db is not None and unit.production_task_line_id is not None:
        from app.models.production import ProductionTaskLine

        line = db.get(ProductionTaskLine, unit.production_task_line_id)
        if line is not None:
            task_name = (line.task.product_model.name if line.task.product_model else None) or line.task.name
    return PartLabelData(
        batch_id=unit.id,
        part_name=unit.part.name,
        quantity_pieces=float(unit.quantity_pieces),
        stage_name=unit.stage.name,
        area=unit.area,
        task_name=task_name,
        note=unit.note,
    )


def render_field_value_pf_unit(data: PartLabelData, key: str, *, show_label: bool = True) -> str | None:
    if key == "batch_id":
        return f"№ {data.batch_id}" if show_label else str(data.batch_id)
    if key == "part_name":
        return f"Деталь: {data.part_name}" if show_label else data.part_name
    if key == "quantity_pieces":
        value = f"{data.quantity_pieces:g} шт"
        return f"Кол-во: {value}" if show_label else value
    if key == "stage_name":
        return f"Этап: {data.stage_name}" if show_label else data.stage_name
    if key == "area":
        if not data.area:
            return ""
        return f"Участок: {data.area}" if show_label else data.area
    if key == "task_name":
        if not data.task_name:
            return None
        return f"Задание: {data.task_name}" if show_label else data.task_name
    if key == "note":
        return data.note or None
    return None


def _pf_unit_label_markup(data: PartLabelData, *, fields: list[dict], width_mm: int, height_mm: int, page_format: PageFormat = "sticker") -> str:
    _register_pdf_fonts()
    qr_src = qr_data_uri(f"ПФ{data.batch_id}")
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)
    giant_field = next((f for f in fields if f.get("size") == "huge"), None)

    if giant_field is not None:
        vertical = bool(giant_field.get("vertical"))
        giant_val = render_field_value_pf_unit(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not vertical) or ""
        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=is_landscape, giant=True)
        if is_landscape:
            qr_html = (
                f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
                f'<img src="{qr_src}" alt="QR партии {data.batch_id}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</td>'
                if has_qr
                else ""
            )
            text_w_mm = max(width_mm - (qr_size_mm + 4 if has_qr else 0) - 2, 5)
            giant_html = _giant_field_html(
                giant_val, _PDF_HEADING_FONT_BOLD, width_mm=text_w_mm, avail_height_mm=height_mm - 2, vertical=vertical,
                font_family_css='font-family:"Cambria", Georgia, serif;',
            )
            return f"""<table class="label-table">
    <tr>
      {qr_html}
      <td class="text-td" style="text-align:center;">
        {giant_html}
      </td>
    </tr>
  </table>"""
        qr_html = (
            f'<div style="margin: 1mm 0; text-align:center;">'
            f'<img src="{qr_src}" alt="QR партии {data.batch_id}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</div>'
            if has_qr
            else ""
        )
        avail_height_mm = height_mm - (qr_size_mm + 2 if has_qr else 2)
        giant_html = _giant_field_html(
            giant_val, _PDF_HEADING_FONT_BOLD, width_mm=width_mm - 4, avail_height_mm=avail_height_mm, vertical=vertical,
            font_family_css='font-family:"Cambria", Georgia, serif;',
        )
        return f"""<div class="label-box">
    {qr_html}
    <div class="content-box" style="padding:0;">
      {giant_html}
    </div>
  </div>"""

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr":
            continue
        val = render_field_value_pf_unit(data, f["key"], show_label=f.get("show_label", True))
        if val:
            rendered_fields.append((f, val))

    if is_landscape:
        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=True)
        qr_html = (
            f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
            f'<img src="{qr_src}" alt="QR партии {data.batch_id}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</td>'
            if has_qr
            else ""
        )
        text_w_mm = max(width_mm - (qr_size_mm + 4 if has_qr else 0) - 2, 5)
        if page_format == "a4":
            text_html = _autofit_fields_html(rendered_fields, width_mm=text_w_mm, avail_height_mm=height_mm - 2, heading_key="batch_id")
        else:
            text_html_items = []
            for f, val in rendered_fields:
                size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
                weight = "bold" if f.get("bold") else "normal"
                is_id = f["key"] == "batch_id"
                font_family = 'font-family:"Cambria", Georgia, serif;' if is_id else ""
                margin = "margin-bottom:1mm;" if is_id else "margin-bottom:0.5mm;"
                text_html_items.append(
                    f'<div style="font-size:{size_pt}pt; font-weight:{weight}; {font_family} {margin} line-height:1.2;">{val}</div>'
                )
            text_html = "".join(text_html_items)
        return f"""<table class="label-table">
    <tr>
      {qr_html}
      <td class="text-td">
        {text_html}
      </td>
    </tr>
  </table>"""

    qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=False)
    if page_format == "a4":
        qr_html = (
            f'<div style="margin: 1mm 0; text-align:center;">'
            f'<img src="{qr_src}" alt="QR партии {data.batch_id}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</div>'
            if has_qr
            else ""
        )
        avail_height_mm = height_mm - (qr_size_mm + 2 if has_qr else 2)
        body_html = _autofit_fields_html(rendered_fields, width_mm=width_mm - 4, avail_height_mm=avail_height_mm, heading_key="batch_id")
        return f"""<div class="label-box">
    {qr_html}
    <div class="content-box">
      {body_html}
    </div>
  </div>"""

    body_items = []
    for f in fields:
        if f["key"] == "qr":
            body_items.append(
                f'<div style="margin: 1mm 0; text-align:center;">'
                f'<img src="{qr_src}" alt="QR партии {data.batch_id}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</div>'
            )
            continue
        val = render_field_value_pf_unit(data, f["key"], show_label=f.get("show_label", True))
        if val:
            size_pt = SIZE_PT.get(f.get("size", "sm"), 8)
            weight = "bold" if f.get("bold") else "normal"
            is_id = f["key"] == "batch_id"
            font_family = 'font-family:"Cambria", Georgia, serif;' if is_id else ""
            body_items.append(
                f'<div style="font-size:{size_pt}pt; font-weight:{weight}; {font_family} margin-bottom:1mm; line-height:1.25;">{val}</div>'
            )
    return f"""<div class="label-box">
    <div class="content-box">
      {"".join(body_items)}
    </div>
  </div>"""


def render_pf_unit_label_html(
    data: PartLabelData, *, fields: list[dict] | None = None, width_mm: int = DEFAULT_PF_UNIT_WIDTH_MM,
    height_mm: int = DEFAULT_PF_UNIT_HEIGHT_MM, vertical: bool = False, page_format: PageFormat = "sticker",
) -> str:
    fields = fields if fields is not None else DEFAULT_FIELDS_PF_UNIT
    markup = _pf_unit_label_markup(data, fields=fields, width_mm=width_mm, height_mm=height_mm, page_format=page_format)
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетка партии №{data.batch_id}</title>
<style>{_label_doc_styles(width_mm, height_mm, vertical)}</style>
</head>
<body>
  <div class="label-page"><div class="label-page-inner">{markup}</div></div>
  <div class="no-print" style="margin-top: 8px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


def render_pf_unit_labels_html_batch(
    items: list[PartLabelData], *, fields: list[dict] | None = None, width_mm: int = DEFAULT_PF_UNIT_WIDTH_MM,
    height_mm: int = DEFAULT_PF_UNIT_HEIGHT_MM, vertical: bool = False, page_format: PageFormat = "sticker",
) -> str:
    fields = fields if fields is not None else DEFAULT_FIELDS_PF_UNIT
    pages = "".join(
        f'<div class="label-page"><div class="label-page-inner">'
        f"{_pf_unit_label_markup(d, fields=fields, width_mm=width_mm, height_mm=height_mm, page_format=page_format)}"
        f"</div></div>"
        for d in items
    )
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетки партий п/ф ({len(items)})</title>
<style>{_label_doc_styles(width_mm, height_mm, vertical)}</style>
</head>
<body>
  {pages}
  <div class="no-print" style="margin-top: 8px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


def _draw_pf_unit_label_page(
    c: pdfcanvas.Canvas, data: PartLabelData, fields: list[dict], width_mm: int, height_mm: int, page_format: PageFormat = "sticker"
) -> None:
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)
    giant_field = next((f for f in fields if f.get("size") == "huge"), None)
    giant_vertical = bool(giant_field.get("vertical")) if giant_field is not None else False

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr" or f is giant_field:
            continue
        val = render_field_value_pf_unit(data, f["key"], show_label=f.get("show_label", True))
        if val:
            rendered_fields.append((f, val))

    width_pt, height_pt = width_mm * MM, height_mm * MM
    c.setStrokeColor(HexColor(BORDER))
    c.setLineWidth(0.5)
    c.roundRect(0.3 * MM, 0.3 * MM, width_pt - 0.6 * MM, height_pt - 0.6 * MM, 1.5 * MM, stroke=1, fill=0)
    _clip_pdf_to_label_bounds(c, width_pt, height_pt)

    qr_reader = ImageReader(BytesIO(qr_png_bytes(f"ПФ{data.batch_id}"))) if has_qr else None

    if is_landscape:
        qr_col_w_mm = 0.0
        if has_qr and qr_reader is not None:
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=True)
            qr_col_w_mm = qr_size_mm + 4
            qr_x_mm = (qr_col_w_mm - qr_size_mm) / 2
            qr_y_mm = (height_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, qr_y_mm * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
        text_x_mm = qr_col_w_mm + 2
        text_w_mm = max(width_mm - text_x_mm - 2, 5)
        if giant_field is not None:
            giant_val = render_field_value_pf_unit(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not giant_vertical) or ""
            _draw_giant_field_pdf(
                c, giant_val, _PDF_HEADING_FONT_BOLD, height_pt=height_pt, left_mm=text_x_mm, top_mm=1,
                width_mm=text_w_mm, avail_height_mm=height_mm - 2, vertical=giant_vertical,
            )
        elif page_format == "a4":
            _draw_autofit_fields_pdf(
                c, rendered_fields, height_pt=height_pt, left_mm=text_x_mm, top_mm=1,
                width_mm=text_w_mm, avail_height_mm=height_mm - 2, heading_key="batch_id",
            )
        else:
            wrapped = _wrap_pdf_fields(c, rendered_fields, text_w_mm * MM, heading_key="batch_id")
            top_mm = max((height_mm - _pdf_text_block_height_mm(wrapped)) / 2, 2)
            _draw_pdf_text_lines(c, wrapped, height_pt, text_x_mm, top_mm, text_w_mm, heading_key="batch_id")
    else:
        top_mm = 3.0
        if has_qr and qr_reader is not None:
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=False, giant=giant_field is not None)
            qr_x_mm = (width_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, height_pt - (top_mm + qr_size_mm) * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
            top_mm += qr_size_mm + 2
        text_w_mm = max(width_mm - 8, 5)
        if giant_field is not None:
            giant_val = render_field_value_pf_unit(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not giant_vertical) or ""
            _draw_giant_field_pdf(
                c, giant_val, _PDF_HEADING_FONT_BOLD, height_pt=height_pt, left_mm=4, top_mm=top_mm,
                width_mm=text_w_mm, avail_height_mm=height_mm - top_mm - 2, vertical=giant_vertical,
            )
        elif page_format == "a4":
            _draw_autofit_fields_pdf(
                c, rendered_fields, height_pt=height_pt, left_mm=4, top_mm=top_mm,
                width_mm=text_w_mm, avail_height_mm=height_mm - top_mm - 2, heading_key="batch_id",
            )
        else:
            wrapped = _wrap_pdf_fields(c, rendered_fields, text_w_mm * MM, heading_key="batch_id")
            _draw_pdf_text_lines(c, wrapped, height_pt, 4, top_mm, text_w_mm, heading_key="batch_id", center=True)
    c.restoreState()


def render_pf_unit_label_pdf(
    data: PartLabelData, *, fields: list[dict] | None = None, width_mm: int = DEFAULT_PF_UNIT_WIDTH_MM,
    height_mm: int = DEFAULT_PF_UNIT_HEIGHT_MM, vertical: bool = False, page_format: PageFormat = "sticker",
) -> bytes:
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS_PF_UNIT
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=_pdf_page_size(width_pt, height_pt, vertical))
    _apply_pdf_vertical_rotation(c, width_pt, height_pt, vertical)
    _draw_pf_unit_label_page(c, data, fields, width_mm, height_mm, page_format=page_format)
    c.showPage()
    c.save()
    return buf.getvalue()


def render_pf_unit_labels_pdf_batch(
    items: list[PartLabelData], *, fields: list[dict] | None = None, width_mm: int = DEFAULT_PF_UNIT_WIDTH_MM,
    height_mm: int = DEFAULT_PF_UNIT_HEIGHT_MM, vertical: bool = False, page_format: PageFormat = "sticker",
) -> bytes:
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS_PF_UNIT
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=_pdf_page_size(width_pt, height_pt, vertical))
    for data in items:
        _apply_pdf_vertical_rotation(c, width_pt, height_pt, vertical)
        _draw_pf_unit_label_page(c, data, fields, width_mm, height_mm, page_format=page_format)
        c.showPage()
    c.save()
    return buf.getvalue()


PREVIEW_DATA_PF_UNIT = PartLabelData(
    batch_id=42,
    part_name="Стоевая 36х108х2035 МДФ ПАЗ-11",
    quantity_pieces=10,
    stage_name="Окутка",
    area="okutka_tsargovykh",
    task_name="Задание №12",
    note=None,
)


# ─── Этикетка полки стеллажа п/ф (kind="pf_shelf") ─────────────────────

DEFAULT_PF_SHELF_WIDTH_MM = 70
DEFAULT_PF_SHELF_HEIGHT_MM = 40

DEFAULT_FIELDS_PF_SHELF: list[dict] = [
    {"key": "qr", "size": "md", "bold": False},
    {"key": "location_code", "size": "lg", "bold": True},
    {"key": "rack_code", "size": "sm", "bold": False},
]

FIELD_META_PF_SHELF: dict[str, dict] = {
    "qr": {"label": "QR-код", "kind": "image"},
    "location_code": {"label": "Код места (полка)", "kind": "text", "has_caption": False},
    "rack_code": {"label": "Код стеллажа", "kind": "text"},
    "shelf": {"label": "Номер полки", "kind": "text"},
}


@dataclass(frozen=True)
class PartShelfLabelData:
    location_code: str
    rack_code: str
    shelf: int


def render_field_value_pf_shelf(data: PartShelfLabelData, key: str, *, show_label: bool = True) -> str | None:
    if key == "location_code":
        return data.location_code
    if key == "rack_code":
        return f"Стеллаж: {data.rack_code}" if show_label else data.rack_code
    if key == "shelf":
        value = str(data.shelf)
        return f"Полка: {value}" if show_label else value
    return None


def _pf_shelf_label_markup(data: PartShelfLabelData, *, fields: list[dict], width_mm: int, height_mm: int, page_format: PageFormat = "sticker") -> str:
    _register_pdf_fonts()
    qr_src = qr_data_uri(data.location_code)
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)
    giant_field = next((f for f in fields if f.get("size") == "huge"), None)

    if giant_field is not None:
        vertical = bool(giant_field.get("vertical"))
        giant_val = render_field_value_pf_shelf(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not vertical) or ""
        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=is_landscape, giant=True)
        if is_landscape:
            qr_html = (
                f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
                f'<img src="{qr_src}" alt="QR {data.location_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</td>'
                if has_qr
                else ""
            )
            text_w_mm = max(width_mm - (qr_size_mm + 4 if has_qr else 0) - 2, 5)
            giant_html = _giant_field_html(
                giant_val, _PDF_HEADING_FONT_BOLD, width_mm=text_w_mm, avail_height_mm=height_mm - 2, vertical=vertical,
                font_family_css='font-family:"Cambria", Georgia, serif;',
            )
            return f"""<table class="label-table">
    <tr>
      {qr_html}
      <td class="text-td" style="text-align:center;">
        {giant_html}
      </td>
    </tr>
  </table>"""
        qr_html = (
            f'<div style="margin: 1mm 0; text-align:center;">'
            f'<img src="{qr_src}" alt="QR {data.location_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</div>'
            if has_qr
            else ""
        )
        avail_height_mm = height_mm - (qr_size_mm + 2 if has_qr else 2)
        giant_html = _giant_field_html(
            giant_val, _PDF_HEADING_FONT_BOLD, width_mm=width_mm - 4, avail_height_mm=avail_height_mm, vertical=vertical,
            font_family_css='font-family:"Cambria", Georgia, serif;',
        )
        return f"""<div class="label-box">
    {qr_html}
    <div class="content-box" style="padding:0;">
      {giant_html}
    </div>
  </div>"""

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr":
            continue
        val = render_field_value_pf_shelf(data, f["key"], show_label=f.get("show_label", True))
        if val:
            rendered_fields.append((f, val))

    if is_landscape:
        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=True)
        qr_html = (
            f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
            f'<img src="{qr_src}" alt="QR {data.location_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</td>'
            if has_qr
            else ""
        )
        text_w_mm = max(width_mm - (qr_size_mm + 4 if has_qr else 0) - 2, 5)
        if page_format == "a4":
            text_html = _autofit_fields_html(rendered_fields, width_mm=text_w_mm, avail_height_mm=height_mm - 2, heading_key="location_code")
        else:
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
            text_html = "".join(text_html_items)
        return f"""<table class="label-table">
    <tr>
      {qr_html}
      <td class="text-td">
        {text_html}
      </td>
    </tr>
  </table>"""

    qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=False)
    if page_format == "a4":
        qr_html = (
            f'<div style="margin: 1mm 0; text-align:center;">'
            f'<img src="{qr_src}" alt="QR {data.location_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</div>'
            if has_qr
            else ""
        )
        avail_height_mm = height_mm - (qr_size_mm + 2 if has_qr else 2)
        body_html = _autofit_fields_html(rendered_fields, width_mm=width_mm - 4, avail_height_mm=avail_height_mm, heading_key="location_code")
        return f"""<div class="label-box">
    {qr_html}
    <div class="content-box">
      {body_html}
    </div>
  </div>"""

    body_items = []
    for f in fields:
        if f["key"] == "qr":
            body_items.append(
                f'<div style="margin: 1mm 0; text-align:center;">'
                f'<img src="{qr_src}" alt="QR {data.location_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</div>'
            )
            continue
        val = render_field_value_pf_shelf(data, f["key"], show_label=f.get("show_label", True))
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


def render_pf_shelf_label_html(
    data: PartShelfLabelData, *, fields: list[dict] | None = None, width_mm: int = DEFAULT_PF_SHELF_WIDTH_MM,
    height_mm: int = DEFAULT_PF_SHELF_HEIGHT_MM, vertical: bool = False, page_format: PageFormat = "sticker",
) -> str:
    fields = fields if fields is not None else DEFAULT_FIELDS_PF_SHELF
    markup = _pf_shelf_label_markup(data, fields=fields, width_mm=width_mm, height_mm=height_mm, page_format=page_format)
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетка {data.location_code}</title>
<style>{_label_doc_styles(width_mm, height_mm, vertical)}</style>
</head>
<body>
  <div class="label-page"><div class="label-page-inner">{markup}</div></div>
  <div class="no-print" style="margin-top: 8px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


def render_pf_shelf_labels_html_batch(
    items: list[PartShelfLabelData], *, fields: list[dict] | None = None, width_mm: int = DEFAULT_PF_SHELF_WIDTH_MM,
    height_mm: int = DEFAULT_PF_SHELF_HEIGHT_MM, vertical: bool = False, page_format: PageFormat = "sticker",
) -> str:
    fields = fields if fields is not None else DEFAULT_FIELDS_PF_SHELF
    pages = "".join(
        f'<div class="label-page"><div class="label-page-inner">'
        f"{_pf_shelf_label_markup(d, fields=fields, width_mm=width_mm, height_mm=height_mm, page_format=page_format)}"
        f"</div></div>"
        for d in items
    )
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетки полок п/ф ({len(items)})</title>
<style>{_label_doc_styles(width_mm, height_mm, vertical)}</style>
</head>
<body>
  {pages}
  <div class="no-print" style="margin-top: 8px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


def _draw_pf_shelf_label_page(
    c: pdfcanvas.Canvas, data: PartShelfLabelData, fields: list[dict], width_mm: int, height_mm: int, page_format: PageFormat = "sticker"
) -> None:
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)
    giant_field = next((f for f in fields if f.get("size") == "huge"), None)
    giant_vertical = bool(giant_field.get("vertical")) if giant_field is not None else False

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr" or f is giant_field:
            continue
        val = render_field_value_pf_shelf(data, f["key"], show_label=f.get("show_label", True))
        if val:
            rendered_fields.append((f, val))

    width_pt, height_pt = width_mm * MM, height_mm * MM
    c.setStrokeColor(HexColor(BORDER))
    c.setLineWidth(0.5)
    c.roundRect(0.3 * MM, 0.3 * MM, width_pt - 0.6 * MM, height_pt - 0.6 * MM, 1.5 * MM, stroke=1, fill=0)
    _clip_pdf_to_label_bounds(c, width_pt, height_pt)

    qr_reader = ImageReader(BytesIO(qr_png_bytes(data.location_code))) if has_qr else None

    if is_landscape:
        qr_col_w_mm = 0.0
        if has_qr and qr_reader is not None:
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=True)
            qr_col_w_mm = qr_size_mm + 4
            qr_x_mm = (qr_col_w_mm - qr_size_mm) / 2
            qr_y_mm = (height_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, qr_y_mm * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
        text_x_mm = qr_col_w_mm + 2
        text_w_mm = max(width_mm - text_x_mm - 2, 5)
        if giant_field is not None:
            giant_val = render_field_value_pf_shelf(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not giant_vertical) or ""
            _draw_giant_field_pdf(
                c, giant_val, _PDF_HEADING_FONT_BOLD, height_pt=height_pt, left_mm=text_x_mm, top_mm=1,
                width_mm=text_w_mm, avail_height_mm=height_mm - 2, vertical=giant_vertical,
            )
        elif page_format == "a4":
            _draw_autofit_fields_pdf(
                c, rendered_fields, height_pt=height_pt, left_mm=text_x_mm, top_mm=1,
                width_mm=text_w_mm, avail_height_mm=height_mm - 2, heading_key="location_code",
            )
        else:
            wrapped = _wrap_pdf_fields(c, rendered_fields, text_w_mm * MM, heading_key="location_code")
            top_mm = max((height_mm - _pdf_text_block_height_mm(wrapped)) / 2, 2)
            _draw_pdf_text_lines(c, wrapped, height_pt, text_x_mm, top_mm, text_w_mm, heading_key="location_code")
    else:
        top_mm = 3.0
        if has_qr and qr_reader is not None:
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=False, giant=giant_field is not None)
            qr_x_mm = (width_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, height_pt - (top_mm + qr_size_mm) * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
            top_mm += qr_size_mm + 2
        text_w_mm = max(width_mm - 8, 5)
        if giant_field is not None:
            giant_val = render_field_value_pf_shelf(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not giant_vertical) or ""
            _draw_giant_field_pdf(
                c, giant_val, _PDF_HEADING_FONT_BOLD, height_pt=height_pt, left_mm=4, top_mm=top_mm,
                width_mm=text_w_mm, avail_height_mm=height_mm - top_mm - 2, vertical=giant_vertical,
            )
        elif page_format == "a4":
            _draw_autofit_fields_pdf(
                c, rendered_fields, height_pt=height_pt, left_mm=4, top_mm=top_mm,
                width_mm=text_w_mm, avail_height_mm=height_mm - top_mm - 2, heading_key="location_code",
            )
        else:
            wrapped = _wrap_pdf_fields(c, rendered_fields, text_w_mm * MM, heading_key="location_code")
            _draw_pdf_text_lines(c, wrapped, height_pt, 4, top_mm, text_w_mm, heading_key="location_code", center=True)
    c.restoreState()


def render_pf_shelf_label_pdf(
    data: PartShelfLabelData, *, fields: list[dict] | None = None, width_mm: int = DEFAULT_PF_SHELF_WIDTH_MM,
    height_mm: int = DEFAULT_PF_SHELF_HEIGHT_MM, vertical: bool = False, page_format: PageFormat = "sticker",
) -> bytes:
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS_PF_SHELF
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=_pdf_page_size(width_pt, height_pt, vertical))
    _apply_pdf_vertical_rotation(c, width_pt, height_pt, vertical)
    _draw_pf_shelf_label_page(c, data, fields, width_mm, height_mm, page_format=page_format)
    c.showPage()
    c.save()
    return buf.getvalue()


def render_pf_shelf_labels_pdf_batch(
    items: list[PartShelfLabelData], *, fields: list[dict] | None = None, width_mm: int = DEFAULT_PF_SHELF_WIDTH_MM,
    height_mm: int = DEFAULT_PF_SHELF_HEIGHT_MM, vertical: bool = False, page_format: PageFormat = "sticker",
) -> bytes:
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS_PF_SHELF
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=_pdf_page_size(width_pt, height_pt, vertical))
    for data in items:
        _apply_pdf_vertical_rotation(c, width_pt, height_pt, vertical)
        _draw_pf_shelf_label_page(c, data, fields, width_mm, height_mm, page_format=page_format)
        c.showPage()
    c.save()
    return buf.getvalue()


PREVIEW_DATA_PF_SHELF = PartShelfLabelData(location_code="ЗГ-1-01", rack_code="ЗГ-1", shelf=1)


# ─── Этикетка стеллажа п/ф целиком (kind="pf_rack") ────────────────────

DEFAULT_PF_RACK_WIDTH_MM = 70
DEFAULT_PF_RACK_HEIGHT_MM = 40

DEFAULT_FIELDS_PF_RACK: list[dict] = [
    {"key": "qr", "size": "md", "bold": False},
    {"key": "rack_code", "size": "lg", "bold": True},
    {"key": "shelf_count", "size": "sm", "bold": False},
]

FIELD_META_PF_RACK: dict[str, dict] = {
    "qr": {"label": "QR-код", "kind": "image"},
    "rack_code": {"label": "Код стеллажа", "kind": "text", "has_caption": False},
    "shelf_count": {"label": "Число полок", "kind": "text"},
}


@dataclass(frozen=True)
class PartRackLabelData:
    rack_code: str
    shelf_count: int


def render_field_value_pf_rack(data: PartRackLabelData, key: str, *, show_label: bool = True) -> str | None:
    if key == "rack_code":
        return data.rack_code
    if key == "shelf_count":
        value = str(data.shelf_count)
        return f"Полок: {value}" if show_label else value
    return None


def _pf_rack_label_markup(data: PartRackLabelData, *, fields: list[dict], width_mm: int, height_mm: int, page_format: PageFormat = "sticker") -> str:
    _register_pdf_fonts()
    qr_src = qr_data_uri(data.rack_code)
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)
    giant_field = next((f for f in fields if f.get("size") == "huge"), None)

    if giant_field is not None:
        vertical = bool(giant_field.get("vertical"))
        giant_val = render_field_value_pf_rack(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not vertical) or ""
        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=is_landscape, giant=True)
        if is_landscape:
            qr_html = (
                f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
                f'<img src="{qr_src}" alt="QR {data.rack_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</td>'
                if has_qr
                else ""
            )
            text_w_mm = max(width_mm - (qr_size_mm + 4 if has_qr else 0) - 2, 5)
            giant_html = _giant_field_html(
                giant_val, _PDF_HEADING_FONT_BOLD, width_mm=text_w_mm, avail_height_mm=height_mm - 2, vertical=vertical,
                font_family_css='font-family:"Cambria", Georgia, serif;',
            )
            return f"""<table class="label-table">
    <tr>
      {qr_html}
      <td class="text-td" style="text-align:center;">
        {giant_html}
      </td>
    </tr>
  </table>"""
        qr_html = (
            f'<div style="margin: 1mm 0; text-align:center;">'
            f'<img src="{qr_src}" alt="QR {data.rack_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</div>'
            if has_qr
            else ""
        )
        avail_height_mm = height_mm - (qr_size_mm + 2 if has_qr else 2)
        giant_html = _giant_field_html(
            giant_val, _PDF_HEADING_FONT_BOLD, width_mm=width_mm - 4, avail_height_mm=avail_height_mm, vertical=vertical,
            font_family_css='font-family:"Cambria", Georgia, serif;',
        )
        return f"""<div class="label-box">
    {qr_html}
    <div class="content-box" style="padding:0;">
      {giant_html}
    </div>
  </div>"""

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr":
            continue
        val = render_field_value_pf_rack(data, f["key"], show_label=f.get("show_label", True))
        if val:
            rendered_fields.append((f, val))

    if is_landscape:
        qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=True)
        qr_html = (
            f'<td class="qr-td" style="width:{qr_size_mm + 4}mm; text-align:center; vertical-align:middle; padding:1mm;">'
            f'<img src="{qr_src}" alt="QR {data.rack_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</td>'
            if has_qr
            else ""
        )
        text_w_mm = max(width_mm - (qr_size_mm + 4 if has_qr else 0) - 2, 5)
        if page_format == "a4":
            text_html = _autofit_fields_html(rendered_fields, width_mm=text_w_mm, avail_height_mm=height_mm - 2, heading_key="rack_code")
        else:
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
            text_html = "".join(text_html_items)
        return f"""<table class="label-table">
    <tr>
      {qr_html}
      <td class="text-td">
        {text_html}
      </td>
    </tr>
  </table>"""

    qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=False)
    if page_format == "a4":
        qr_html = (
            f'<div style="margin: 1mm 0; text-align:center;">'
            f'<img src="{qr_src}" alt="QR {data.rack_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
            f'</div>'
            if has_qr
            else ""
        )
        avail_height_mm = height_mm - (qr_size_mm + 2 if has_qr else 2)
        body_html = _autofit_fields_html(rendered_fields, width_mm=width_mm - 4, avail_height_mm=avail_height_mm, heading_key="rack_code")
        return f"""<div class="label-box">
    {qr_html}
    <div class="content-box">
      {body_html}
    </div>
  </div>"""

    body_items = []
    for f in fields:
        if f["key"] == "qr":
            body_items.append(
                f'<div style="margin: 1mm 0; text-align:center;">'
                f'<img src="{qr_src}" alt="QR {data.rack_code}" style="width:{qr_size_mm}mm; height:{qr_size_mm}mm; display:block; margin:0 auto;">'
                f'</div>'
            )
            continue
        val = render_field_value_pf_rack(data, f["key"], show_label=f.get("show_label", True))
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


def render_pf_rack_label_html(
    data: PartRackLabelData, *, fields: list[dict] | None = None, width_mm: int = DEFAULT_PF_RACK_WIDTH_MM,
    height_mm: int = DEFAULT_PF_RACK_HEIGHT_MM, vertical: bool = False, page_format: PageFormat = "sticker",
) -> str:
    fields = fields if fields is not None else DEFAULT_FIELDS_PF_RACK
    markup = _pf_rack_label_markup(data, fields=fields, width_mm=width_mm, height_mm=height_mm, page_format=page_format)
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Этикетка стеллажа {data.rack_code}</title>
<style>{_label_doc_styles(width_mm, height_mm, vertical)}</style>
</head>
<body>
  <div class="label-page"><div class="label-page-inner">{markup}</div></div>
  <div class="no-print" style="margin-top: 8px;">
    <button onclick="window.print()">Печать</button>
  </div>
</body>
</html>"""


def _draw_pf_rack_label_page(
    c: pdfcanvas.Canvas, data: PartRackLabelData, fields: list[dict], width_mm: int, height_mm: int, page_format: PageFormat = "sticker"
) -> None:
    is_landscape = width_mm >= height_mm
    has_qr = any(f["key"] == "qr" for f in fields)
    giant_field = next((f for f in fields if f.get("size") == "huge"), None)
    giant_vertical = bool(giant_field.get("vertical")) if giant_field is not None else False

    rendered_fields: list[tuple[dict, str]] = []
    for f in fields:
        if f["key"] == "qr" or f is giant_field:
            continue
        val = render_field_value_pf_rack(data, f["key"], show_label=f.get("show_label", True))
        if val:
            rendered_fields.append((f, val))

    width_pt, height_pt = width_mm * MM, height_mm * MM
    c.setStrokeColor(HexColor(BORDER))
    c.setLineWidth(0.5)
    c.roundRect(0.3 * MM, 0.3 * MM, width_pt - 0.6 * MM, height_pt - 0.6 * MM, 1.5 * MM, stroke=1, fill=0)
    _clip_pdf_to_label_bounds(c, width_pt, height_pt)

    qr_reader = ImageReader(BytesIO(qr_png_bytes(data.rack_code))) if has_qr else None

    if is_landscape:
        qr_col_w_mm = 0.0
        if has_qr and qr_reader is not None:
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=True)
            qr_col_w_mm = qr_size_mm + 4
            qr_x_mm = (qr_col_w_mm - qr_size_mm) / 2
            qr_y_mm = (height_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, qr_y_mm * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
        text_x_mm = qr_col_w_mm + 2
        text_w_mm = max(width_mm - text_x_mm - 2, 5)
        if giant_field is not None:
            giant_val = render_field_value_pf_rack(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not giant_vertical) or ""
            _draw_giant_field_pdf(
                c, giant_val, _PDF_HEADING_FONT_BOLD, height_pt=height_pt, left_mm=text_x_mm, top_mm=1,
                width_mm=text_w_mm, avail_height_mm=height_mm - 2, vertical=giant_vertical,
            )
        elif page_format == "a4":
            _draw_autofit_fields_pdf(
                c, rendered_fields, height_pt=height_pt, left_mm=text_x_mm, top_mm=1,
                width_mm=text_w_mm, avail_height_mm=height_mm - 2, heading_key="rack_code",
            )
        else:
            wrapped = _wrap_pdf_fields(c, rendered_fields, text_w_mm * MM, heading_key="rack_code")
            top_mm = max((height_mm - _pdf_text_block_height_mm(wrapped)) / 2, 2)
            _draw_pdf_text_lines(c, wrapped, height_pt, text_x_mm, top_mm, text_w_mm, heading_key="rack_code")
    else:
        top_mm = 3.0
        if has_qr and qr_reader is not None:
            qr_size_mm = _qr_size_mm(width_mm, height_mm, page_format, is_landscape=False, giant=giant_field is not None)
            qr_x_mm = (width_mm - qr_size_mm) / 2
            c.drawImage(qr_reader, qr_x_mm * MM, height_pt - (top_mm + qr_size_mm) * MM, qr_size_mm * MM, qr_size_mm * MM, mask="auto")
            top_mm += qr_size_mm + 2
        text_w_mm = max(width_mm - 8, 5)
        if giant_field is not None:
            giant_val = render_field_value_pf_rack(data, giant_field["key"], show_label=bool(giant_field.get("show_label", True)) and not giant_vertical) or ""
            _draw_giant_field_pdf(
                c, giant_val, _PDF_HEADING_FONT_BOLD, height_pt=height_pt, left_mm=4, top_mm=top_mm,
                width_mm=text_w_mm, avail_height_mm=height_mm - top_mm - 2, vertical=giant_vertical,
            )
        elif page_format == "a4":
            _draw_autofit_fields_pdf(
                c, rendered_fields, height_pt=height_pt, left_mm=4, top_mm=top_mm,
                width_mm=text_w_mm, avail_height_mm=height_mm - top_mm - 2, heading_key="rack_code",
            )
        else:
            wrapped = _wrap_pdf_fields(c, rendered_fields, text_w_mm * MM, heading_key="rack_code")
            _draw_pdf_text_lines(c, wrapped, height_pt, 4, top_mm, text_w_mm, heading_key="rack_code", center=True)
    c.restoreState()


def render_pf_rack_label_pdf(
    data: PartRackLabelData, *, fields: list[dict] | None = None, width_mm: int = DEFAULT_PF_RACK_WIDTH_MM,
    height_mm: int = DEFAULT_PF_RACK_HEIGHT_MM, vertical: bool = False, page_format: PageFormat = "sticker",
) -> bytes:
    _register_pdf_fonts()
    fields = fields if fields is not None else DEFAULT_FIELDS_PF_RACK
    width_pt, height_pt = width_mm * MM, height_mm * MM
    buf = BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=_pdf_page_size(width_pt, height_pt, vertical))
    _apply_pdf_vertical_rotation(c, width_pt, height_pt, vertical)
    _draw_pf_rack_label_page(c, data, fields, width_mm, height_mm, page_format=page_format)
    c.showPage()
    c.save()
    return buf.getvalue()


PREVIEW_DATA_PF_RACK = PartRackLabelData(rack_code="ЗГ-1", shelf_count=8)
