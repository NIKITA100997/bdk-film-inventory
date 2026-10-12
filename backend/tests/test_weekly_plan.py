from datetime import date
from types import SimpleNamespace

from app.services.weekly_plan import order_day, week_start


def test_week_starts_on_monday():
    assert week_start(date(2026, 10, 19)) == date(2026, 10, 19)
    assert week_start(date(2026, 10, 25)) == date(2026, 10, 19)
    assert week_start(date(2026, 10, 26)) == date(2026, 10, 26)


def test_order_day_prefers_promised_ready():
    assert order_day(SimpleNamespace(promised_ready=date(2026, 10, 21), ship_date=date(2026, 10, 24))) == date(2026, 10, 21)
    assert order_day(SimpleNamespace(promised_ready=None, ship_date=date(2026, 10, 24))) == date(2026, 10, 24)
