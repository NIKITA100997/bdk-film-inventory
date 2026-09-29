from datetime import date

from app.services.planning import add_workdays, is_workday, to_workday, workdays_between

MON = date(2026, 9, 28)  # понедельник
FRI = date(2026, 10, 2)
SAT = date(2026, 10, 3)


def test_weekend_is_not_workday():
    assert is_workday(FRI) and not is_workday(SAT)


def test_to_workday_moves_off_weekend():
    assert to_workday(SAT) == date(2026, 10, 5)
    assert to_workday(SAT, forward=False) == FRI


def test_add_workdays_skips_weekend_both_ways():
    assert add_workdays(FRI, 1) == date(2026, 10, 5)
    assert add_workdays(date(2026, 10, 5), -1) == FRI
    assert add_workdays(MON, 4) == FRI


def test_workdays_between_counts_only_workdays():
    assert workdays_between(FRI, date(2026, 10, 5)) == 1
    assert workdays_between(date(2026, 10, 5), FRI) == -1
    assert workdays_between(MON, MON) == 0
