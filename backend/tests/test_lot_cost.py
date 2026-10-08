from types import SimpleNamespace

from app.services.lot_cost import event_amount, unit_value


def test_event_amount_signed_by_delta():
    # приход 300 м рулона 1000 мм по 120 ₽/м² = 36 000 ₽; выдача — с минусом
    assert event_amount(300, 1000, 120) == 36000
    assert event_amount(-50, 220, 95.5) == -1050.5


def test_no_price_no_amount():
    assert event_amount(10, 1000, None) is None


def test_unit_value():
    assert unit_value(SimpleNamespace(price_per_m2=100, length_m=12.5, width_mm=1400)) == 1750
    assert unit_value(SimpleNamespace(price_per_m2=None, length_m=12.5, width_mm=1400)) is None
