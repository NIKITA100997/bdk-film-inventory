from datetime import date

from app.services.needs_weekly import LATER, NODATE, OVERDUE, bucket_of, buckets


def test_buckets_start_on_monday():
    bs = buckets(date(2026, 10, 22), 3)  # четверг
    assert [b.key for b in bs] == [OVERDUE, "2026-10-19", "2026-10-26", "2026-11-02", LATER, NODATE]
    assert bs[1].end == date(2026, 10, 25)
    assert bs[4].start == date(2026, 11, 9)


def test_bucket_of():
    bs = buckets(date(2026, 10, 22), 3)
    assert bucket_of(None, bs) == NODATE
    assert bucket_of(date(2026, 10, 18), bs) == OVERDUE
    assert bucket_of(date(2026, 10, 19), bs) == "2026-10-19"
    assert bucket_of(date(2026, 10, 26), bs) == "2026-10-26"
    assert bucket_of(date(2026, 11, 8), bs) == "2026-11-02"
    assert bucket_of(date(2026, 11, 9), bs) == LATER
