from app.models.part_counts import DECISION_ACCEPT, DECISION_KEEP, DECISION_WRITE_OFF
from app.services.part_counts import allowed_decisions, diff_of


def test_diff_not_counted():
    assert diff_of(10, None) is None
    assert allowed_decisions(10, None) == []


def test_diff_matches():
    assert diff_of(10, 10) == 0
    assert allowed_decisions(10, 10) == []


def test_shortage_write_off_or_keep():
    assert diff_of(10, 7) == -3
    assert allowed_decisions(10, 7) == [DECISION_WRITE_OFF, DECISION_KEEP]


def test_surplus_accept_or_keep():
    assert diff_of(0, 5) == 5
    assert allowed_decisions(0, 5) == [DECISION_ACCEPT, DECISION_KEEP]
