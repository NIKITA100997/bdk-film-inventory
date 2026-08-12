from datetime import date
from types import SimpleNamespace

from app.services.labels import (
    DEFAULT_FIELDS,
    LabelData,
    indicator_color,
    label_data_from_unit,
    render_field_value,
    render_label_html,
    render_label_pdf,
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
        width_mm=1400,
        length_m=214,
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

    def test_unknown_key_returns_none(self):
        assert render_field_value(SAMPLE, "does_not_exist") is None


class TestIndicatorColor:
    def test_roll_when_no_parent(self):
        assert indicator_color(SAMPLE) == "#1D9E75"

    def test_strip_when_has_parent(self):
        data = SAMPLE.__class__(**{**SAMPLE.__dict__, "parent_id": 7})
        assert indicator_color(data) == "#2C2E3A"


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
