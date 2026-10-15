from types import SimpleNamespace

from app.services.film_reserve import _roll_meters


def test_same_width_takes_strip_meters():
    assert _roll_meters(SimpleNamespace(width_mm=83), 83, 100, True) == 100


def test_wide_roll_is_cut_into_strips():
    # 1220 мм на штрипсы 300 — 4 в ширину: 100 м штрипса = 25 м рулона
    assert _roll_meters(SimpleNamespace(width_mm=1220), 300, 100, False) == 25


def test_roll_narrower_than_two_strips_counts_one():
    assert _roll_meters(SimpleNamespace(width_mm=500), 300, 40, False) == 40
