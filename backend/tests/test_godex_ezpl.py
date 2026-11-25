"""Тесты генерации EZPL и эндпоинтов прямой печати Godex G500."""

from datetime import date
from fastapi.testclient import TestClient

from app.main import app
from app.services.godex_ezpl import (
    build_ezpl_job,
    build_units_ezpl_job,
    is_allowed_printer_ip,
    list_network_printers,
    parse_godex_status,
    render_test_bitmap,
    send_ezpl_to_printer,
)
from app.services.labels import DEFAULT_FIELDS, LabelData


def test_ezpl_test_bitmap_and_job_format():
    img = render_test_bitmap(index=1, total=10, width_mm=100, height_mm=40)
    assert img.size == (800, 320)
    payload = build_ezpl_job([img], width_mm=100, height_mm=40)
    assert payload.startswith(b"^Q40,3\r\n^W100\r\n")
    assert b"^L\r\nQ0,0,100,320\r\n" in payload
    assert payload.endswith(b"\r\nE\r\n")


def test_ezpl_unit_label_rendering():
    data = LabelData(
        unit_id=4201,
        material="ПВХ",
        color="Дуб Сонома",
        thickness_mm=0.35,
        manufacturer="Alfa",
        upd_number="УПД-12",
        pallet_number="П-3",
        received_date=date(2026, 11, 25),
        supplier_code="ALF-01",
        native_width_mm=1260.0,
        parent_id=None,
        is_strip=False,
        width_mm=1260.0,
        length_m=300.0,
    )
    ezpl = build_units_ezpl_job([data], fields=DEFAULT_FIELDS, width_mm=100, height_mm=40, vertical=False)
    assert b"^Q40,3\r\n^W100\r\n" in ezpl
    assert b"Q0,0,100,320\r\n" in ezpl


def test_network_printers_allowlist():
    printers = list_network_printers()
    ips = {p["ip"] for p in printers}
    assert "192.168.1.49" in ips
    assert "192.168.1.37" in ips
    assert is_allowed_printer_ip("192.168.1.49") is True
    assert is_allowed_printer_ip("10.0.0.1") is False


def test_printers_endpoint_requires_auth():
    client = TestClient(app)
    res = client.get("/api/labels/printers")
    assert res.status_code in (401, 403)


def test_parse_godex_status_and_preprint_block(monkeypatch):
    assert parse_godex_status("00,00000\r\n")["ok"] is True
    empty = parse_godex_status("01,00000\r\n")
    assert empty["ok"] is False
    assert "лента" in empty["message"].lower()
    head = parse_godex_status("04,00000\r\n")
    assert head["ok"] is False
    assert "крышка" in head["message"].lower()

    monkeypatch.setattr(
        "app.services.godex_ezpl.query_printer_status",
        lambda ip, port=9100, timeout=2.0: {"ok": False, "code": "01", "message": "Godex G500: Закончилась лента (этикетки)"},
    )
    import pytest

    with pytest.raises(RuntimeError, match="Закончилась лента"):
        send_ezpl_to_printer("192.168.1.49", b"^L\r\nE\r\n")
