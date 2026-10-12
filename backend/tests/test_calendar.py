from datetime import date

from app.services import planning as pl


def setup_function():
    pl._CAL.clear()
    pl._CAL_AT[0] = 10**12  # не перечитывать из базы


def teardown_function():
    pl._CAL.clear()
    pl._CAL_AT[0] = 0.0


def test_holiday_skipped():
    pl._CAL[(date(2026, 11, 4), None)] = False
    assert not pl.is_workday(date(2026, 11, 4))
    assert pl.add_workdays(date(2026, 11, 3), 1) == date(2026, 11, 5)


def test_saturday_only_for_area():
    pl._CAL[(date(2026, 11, 7), "kromka")] = True
    assert pl.is_workday(date(2026, 11, 7), "kromka")
    assert not pl.is_workday(date(2026, 11, 7), "upakovka")
    assert pl.add_workdays(date(2026, 11, 6), 1, "kromka") == date(2026, 11, 7)
    assert pl.add_workdays(date(2026, 11, 6), 1) == date(2026, 11, 9)


def test_area_day_off_overrides_global_workday():
    pl._CAL[(date(2026, 11, 10), "kromka")] = False  # отключили свет
    assert not pl.is_workday(date(2026, 11, 10), "kromka")
    assert pl.is_workday(date(2026, 11, 10), "upakovka")
    assert pl.workdays_between(date(2026, 11, 9), date(2026, 11, 11), "kromka") == 1
