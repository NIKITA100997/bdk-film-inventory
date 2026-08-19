from datetime import date
from io import BytesIO
from types import SimpleNamespace

from reportlab.pdfgen import canvas as pdfcanvas

from reportlab.pdfbase import pdfmetrics

from app.services.labels import (
    DEFAULT_FIELDS,
    LabelData,
    _fit_font_size_horizontal,
    _fit_font_size_vertical,
    _wrap_pdf_text,
    indicator_color,
    label_data_from_unit,
    render_field_value,
    render_label_html,
    render_label_pdf,
    render_labels_pdf_batch,
)

SAMPLE = LabelData(
    unit_id=42,
    material="ПВХ плёнка",
    color="Дуб беленый",
    thickness_mm=0.35,
    manufacturer="Классен",
    upd_number="УПД-1",
    pallet_number="3",
    received_date=date(2026, 1, 15),
    supplier_code="KL-9",
    native_width_mm=1400,
    parent_id=None,
    is_strip=False,
    width_mm=1400,
    length_m=214,
)


def make_unit(**overrides):
    sku = SimpleNamespace(
        material=SimpleNamespace(name="ПВХ плёнка"),
        color=SimpleNamespace(name="Дуб беленый"),
        thickness=SimpleNamespace(value_mm=0.35),
        manufacturer=SimpleNamespace(name="Классен"),
        supplier_code="KL-9",
        native_width_mm=1400,
    )
    defaults = dict(
        id=42,
        material_sku=sku,
        upd_number="УПД-1",
        pallet_number="3",
        created_at=SimpleNamespace(date=lambda: date(2026, 1, 15)),
        parent_id=None,
        is_strip=False,
        width_mm=1400,
        length_m=214,
        production_task_line=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class TestLabelDataFromUnit:
    def test_extracts_flat_snapshot(self):
        data = label_data_from_unit(make_unit())
        assert data.unit_id == 42
        assert data.material == "ПВХ плёнка"
        assert data.native_width_mm == 1400

    def test_missing_created_at_is_none(self):
        data = label_data_from_unit(make_unit(created_at=None))
        assert data.received_date is None

    def test_no_task_line_leaves_assignment_empty(self):
        data = label_data_from_unit(make_unit())
        assert data.task_name is None
        assert data.part_name is None

    def test_task_line_populates_assignment_from_product_model(self):
        line = SimpleNamespace(
            part_name="Стоевая",
            task=SimpleNamespace(product_model=SimpleNamespace(name="Дверь царговая"), name="Ручное задание"),
        )
        data = label_data_from_unit(make_unit(production_task_line=line))
        assert data.part_name == "Стоевая"
        assert data.task_name == "Дверь царговая"  # приоритет у модели, как в _task_out

    def test_task_line_falls_back_to_manual_task_name(self):
        line = SimpleNamespace(part_name="Добор 150", task=SimpleNamespace(product_model=None, name="QA-TEST-Задание"))
        data = label_data_from_unit(make_unit(production_task_line=line))
        assert data.task_name == "QA-TEST-Задание"


class TestRenderFieldValue:
    def test_unit_id_formatted(self):
        assert render_field_value(SAMPLE, "unit_id") == "№ 42"

    def test_parent_ref_none_when_no_parent(self):
        assert render_field_value(SAMPLE, "parent_ref") is None

    def test_parent_ref_present_when_has_parent(self):
        data = SAMPLE.__class__(**{**SAMPLE.__dict__, "parent_id": 7})
        assert render_field_value(data, "parent_ref") == "Из рулона №7"

    def test_supplier_code_empty_string_when_none(self):
        data = SAMPLE.__class__(**{**SAMPLE.__dict__, "supplier_code": None})
        assert render_field_value(data, "supplier_code") == ""

    def test_fields_printed_with_caption(self):
        assert render_field_value(SAMPLE, "material") == "Материал: ПВХ плёнка"
        assert render_field_value(SAMPLE, "thickness") == "Толщина: 0.35 мм"
        assert render_field_value(SAMPLE, "width_mm") == "Ш: 1400 мм"
        assert render_field_value(SAMPLE, "length_m") == "Д: 214 м"
        assert render_field_value(SAMPLE, "upd_number") == "УПД: УПД-1"

    def test_unknown_key_returns_none(self):
        assert render_field_value(SAMPLE, "does_not_exist") is None

    def test_dimensions_m_converts_width_to_meters_and_strips_zeros(self):
        # width_mm=1400 -> 1,4 м; length_m=214 (уже в метрах, целое) -> 214.
        assert render_field_value(SAMPLE, "dimensions_m") == "1,4×214"

    def test_task_assignment_none_when_no_task_line(self):
        assert render_field_value(SAMPLE, "task_assignment") is None

    def test_task_assignment_combines_part_and_task_name(self):
        data = SAMPLE.__class__(**{**SAMPLE.__dict__, "part_name": "Стоевая", "task_name": "Дверь царговая"})
        assert render_field_value(data, "task_assignment") == "Куда: Стоевая — Дверь царговая"

    def test_task_assignment_shows_whichever_part_is_present(self):
        data = SAMPLE.__class__(**{**SAMPLE.__dict__, "part_name": "Стоевая", "task_name": None})
        assert render_field_value(data, "task_assignment") == "Куда: Стоевая"

    def test_dimensions_m_keeps_fractional_length(self):
        data = SAMPLE.__class__(**{**SAMPLE.__dict__, "width_mm": 500, "length_m": 3.5})
        assert render_field_value(data, "dimensions_m") == "0,5×3,5"


class TestRenderFieldValueShowLabel:
    """Раздел про возможность убрать подпись — show_label=False оставляет
    только значение, единицы измерения (мм/м) остаются: это часть
    значения, не подпись."""

    def test_show_label_false_strips_caption(self):
        assert render_field_value(SAMPLE, "material", show_label=False) == "ПВХ плёнка"
        assert render_field_value(SAMPLE, "color", show_label=False) == "Дуб беленый"
        assert render_field_value(SAMPLE, "upd_number", show_label=False) == "УПД-1"

    def test_show_label_false_keeps_unit_suffix(self):
        assert render_field_value(SAMPLE, "thickness", show_label=False) == "0.35 мм"
        assert render_field_value(SAMPLE, "width_mm", show_label=False) == "1400 мм"
        assert render_field_value(SAMPLE, "length_m", show_label=False) == "214 м"

    def test_show_label_false_strips_symbol_prefix_too(self):
        # "№" у unit_id — тоже приставка, не часть значения.
        assert render_field_value(SAMPLE, "unit_id", show_label=False) == "42"

    def test_captionless_fields_unaffected_by_show_label(self):
        # dimensions_m никогда не имело подписи — show_label не влияет.
        assert render_field_value(SAMPLE, "dimensions_m", show_label=False) == render_field_value(SAMPLE, "dimensions_m", show_label=True)

    def test_show_label_true_is_default_and_unchanged(self):
        assert render_field_value(SAMPLE, "material") == render_field_value(SAMPLE, "material", show_label=True)


class TestIndicatorColor:
    def test_roll_when_not_strip(self):
        assert indicator_color(SAMPLE) == "#1D9E75"

    def test_strip_when_is_strip(self):
        data = SAMPLE.__class__(**{**SAMPLE.__dict__, "is_strip": True})
        assert indicator_color(data) == "#2C2E3A"


class TestWrapPdfText:
    """Раздел обратной связи "на планшете переносит, на компе обрезает" —
    PDF-путь раньше рисовал значение одной строкой без переноса, длинные
    значения печатались обрезанными за краем этикетки."""

    c = pdfcanvas.Canvas(BytesIO())

    def test_short_text_stays_one_line(self):
        assert _wrap_pdf_text(self.c, "ПВХ плёнка", "Helvetica", 10, 200) == ["ПВХ плёнка"]

    def test_long_text_wraps_by_words(self):
        text = "Дверь царговая массив дуба беленый премиум"
        # ширина чуть больше самого длинного отдельного слова — перенос
        # только между словами, без разбивки по буквам (см. отдельный тест
        # ниже про слово шире всей коробки).
        widest_word = max(text.split(" "), key=lambda w: self.c.stringWidth(w, "Helvetica", 10))
        max_width_pt = self.c.stringWidth(widest_word, "Helvetica", 10) + 1
        lines = _wrap_pdf_text(self.c, text, "Helvetica", 10, max_width_pt)
        assert len(lines) > 1
        for line in lines:
            assert self.c.stringWidth(line, "Helvetica", 10) <= max_width_pt
        # слова не потерялись и не задвоились при переносе
        assert " ".join(lines) == text

    def test_single_word_wider_than_box_is_broken_by_character(self):
        lines = _wrap_pdf_text(self.c, "Суперкалифраджилистикэкспиалидоциус", "Helvetica", 10, 40)
        assert len(lines) > 1
        for line in lines:
            assert self.c.stringWidth(line, "Helvetica", 10) <= 40
        assert "".join(lines) == "Суперкалифраджилистикэкспиалидоциус"

    def test_empty_text_returns_single_empty_line(self):
        assert _wrap_pdf_text(self.c, "", "Helvetica", 10, 100) == [""]


class TestFitFontSizeHorizontal:
    """Раздел про огромный номер на этикетке места хранения (size="huge")
    — наибольший кегль, при котором текст одной строкой помещается в
    прямоугольник. Проверяем через реальный pdfmetrics.stringWidth, не
    моком — тот же путь, что и сам код."""

    def test_fits_within_bounds(self):
        size = _fit_font_size_horizontal("Р-3-07", "Helvetica", max_width_pt=200, max_height_pt=100)
        assert pdfmetrics.stringWidth("Р-3-07", "Helvetica", size) <= 200
        assert size * 1.15 <= 100

    def test_bigger_box_gives_bigger_font(self):
        small = _fit_font_size_horizontal("07", "Helvetica", max_width_pt=50, max_height_pt=50)
        big = _fit_font_size_horizontal("07", "Helvetica", max_width_pt=500, max_height_pt=500)
        assert big > small

    def test_longer_text_gets_smaller_font_in_same_box(self):
        short = _fit_font_size_horizontal("7", "Helvetica", max_width_pt=200, max_height_pt=200)
        long = _fit_font_size_horizontal("Р-12-345", "Helvetica", max_width_pt=200, max_height_pt=200)
        assert long < short

    def test_height_constrained_box_caps_font_regardless_of_width(self):
        size = _fit_font_size_horizontal("7", "Helvetica", max_width_pt=10_000, max_height_pt=20)
        assert size * 1.15 <= 20

    def test_empty_text_does_not_crash(self):
        assert _fit_font_size_horizontal("", "Helvetica", max_width_pt=100, max_height_pt=100) > 0


class TestFitFontSizeVertical:
    """Как TestFitFontSizeHorizontal, но для варианта "друг над другом" —
    по одному символу на строку."""

    def test_fits_within_bounds(self):
        text = "Р307"
        size = _fit_font_size_vertical(text, "Helvetica", max_width_pt=100, max_height_pt=400)
        assert max(pdfmetrics.stringWidth(ch, "Helvetica", size) for ch in text) <= 100
        assert size * 1.15 * len(text) <= 400

    def test_more_characters_get_smaller_font_in_same_box(self):
        two_chars = _fit_font_size_vertical("07", "Helvetica", max_width_pt=200, max_height_pt=200)
        five_chars = _fit_font_size_vertical("Р-3-07", "Helvetica", max_width_pt=200, max_height_pt=200)
        assert five_chars < two_chars

    def test_width_constrained_by_widest_character_not_whole_string(self):
        # Ширина ограничена САМЫМ ШИРОКИМ символом (не суммой всех) — узкая
        # "1" рядом с широкой "Р" не должна урезать кегль так, будто вся
        # строка "Р1" стоит в одну линию.
        size = _fit_font_size_vertical("Р1", "Helvetica", max_width_pt=50, max_height_pt=1000)
        widest = max(pdfmetrics.stringWidth("Р", "Helvetica", size), pdfmetrics.stringWidth("1", "Helvetica", size))
        assert widest <= 50

    def test_empty_text_does_not_crash(self):
        assert _fit_font_size_vertical("", "Helvetica", max_width_pt=100, max_height_pt=100) > 0


class TestRenderLabelHtml:
    def test_default_fields_omit_width_and_length(self):
        html = render_label_html(SAMPLE, fields=DEFAULT_FIELDS)
        assert "1400 мм" not in html
        assert "214 м" not in html

    def test_width_length_appear_when_explicitly_added(self):
        fields = DEFAULT_FIELDS + [{"key": "width_mm", "size": "sm", "bold": False}]
        html = render_label_html(SAMPLE, fields=fields)
        assert "1400 мм" in html

    def test_custom_physical_size_reflected_in_page_rule(self):
        html = render_label_html(SAMPLE, fields=DEFAULT_FIELDS, width_mm=40, height_mm=60)
        assert "size: 40mm 60mm" in html

    def test_parent_ref_field_skipped_when_no_parent(self):
        fields = [{"key": "parent_ref", "size": "sm", "bold": False}]
        html = render_label_html(SAMPLE, fields=fields)
        assert "Из рулона" not in html


class TestRenderLabelPdf:
    """PDF — основной путь печати с раздела обратной связи по Codex G500
    (прямая печать HTML из браузера на термопринтер ненадёжна). Бинарный
    формат не даёт проверить текст по подстроке, как для HTML — тесты
    проверяют, что рендер не падает на разных конфигурациях полей/размеров
    и производит валидный PDF-поток."""

    def test_produces_valid_pdf_bytes_landscape(self):
        pdf = render_label_pdf(SAMPLE, fields=DEFAULT_FIELDS, width_mm=100, height_mm=40)
        assert pdf.startswith(b"%PDF-")
        assert pdf.rstrip().endswith(b"%%EOF")

    def test_produces_valid_pdf_bytes_portrait(self):
        pdf = render_label_pdf(SAMPLE, fields=DEFAULT_FIELDS, width_mm=60, height_mm=90)
        assert pdf.startswith(b"%PDF-")

    def test_empty_fields_still_renders(self):
        pdf = render_label_pdf(SAMPLE, fields=[], width_mm=100, height_mm=40)
        assert pdf.startswith(b"%PDF-")

    def test_no_qr_no_stripe_still_renders(self):
        fields = [f for f in DEFAULT_FIELDS if f["key"] not in ("qr", "status_stripe")]
        pdf = render_label_pdf(SAMPLE, fields=fields, width_mm=100, height_mm=40)
        assert pdf.startswith(b"%PDF-")


class TestRenderLabelsPdfBatch:
    """Очередь печати (раздел про ускорение работы) — один PDF на несколько
    единиц вместо N отдельных запросов/вкладок."""

    def test_single_item_produces_valid_pdf(self):
        pdf = render_labels_pdf_batch([SAMPLE], fields=DEFAULT_FIELDS, width_mm=100, height_mm=40)
        assert pdf.startswith(b"%PDF-")
        assert pdf.rstrip().endswith(b"%%EOF")

    def test_multiple_items_produce_valid_pdf(self):
        other = SAMPLE.__class__(**{**SAMPLE.__dict__, "unit_id": 43})
        pdf = render_labels_pdf_batch([SAMPLE, other, SAMPLE], fields=DEFAULT_FIELDS, width_mm=100, height_mm=40)
        assert pdf.startswith(b"%PDF-")
        assert pdf.rstrip().endswith(b"%%EOF")

    def test_more_items_produce_larger_pdf(self):
        one = render_labels_pdf_batch([SAMPLE], fields=DEFAULT_FIELDS, width_mm=100, height_mm=40)
        three = render_labels_pdf_batch([SAMPLE] * 3, fields=DEFAULT_FIELDS, width_mm=100, height_mm=40)
        assert len(three) > len(one)

    def test_empty_list_still_produces_valid_pdf(self):
        pdf = render_labels_pdf_batch([], fields=DEFAULT_FIELDS, width_mm=100, height_mm=40)
        assert pdf.startswith(b"%PDF-")
