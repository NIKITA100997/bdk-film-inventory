from datetime import datetime

from app.services.suppliers import ClosedRequestRecord, compute_supplier_stats


def make_record(**overrides):
    defaults = dict(
        supplier_id=1,
        supplier_name="ООО Плёнка",
        price_per_m2=100.0,
        created_at=datetime(2026, 1, 1),
        closed_at=datetime(2026, 1, 6),
    )
    defaults.update(overrides)
    return ClosedRequestRecord(**defaults)


def test_empty_records_returns_empty_list():
    assert compute_supplier_stats([]) == []


def test_single_supplier_averages_price_and_lead_time():
    records = [
        make_record(price_per_m2=100.0, created_at=datetime(2026, 1, 1), closed_at=datetime(2026, 1, 6)),
        make_record(price_per_m2=200.0, created_at=datetime(2026, 1, 10), closed_at=datetime(2026, 1, 12)),
    ]
    stats = compute_supplier_stats(records)
    assert len(stats) == 1
    s = stats[0]
    assert s.supplier_id == 1
    assert s.closed_requests == 2
    assert s.avg_price_per_m2 == 150.0
    assert s.avg_lead_time_days == 3.5  # (5 + 2) / 2
    assert s.last_request_at == datetime(2026, 1, 10)


def test_missing_price_excluded_from_average_but_counted():
    records = [
        make_record(price_per_m2=100.0),
        make_record(price_per_m2=None),
    ]
    stats = compute_supplier_stats(records)
    assert stats[0].closed_requests == 2
    assert stats[0].avg_price_per_m2 == 100.0


def test_missing_closed_at_excluded_from_lead_time():
    records = [
        make_record(closed_at=datetime(2026, 1, 6)),
        make_record(closed_at=None),
    ]
    stats = compute_supplier_stats(records)
    assert stats[0].avg_lead_time_days == 5.0


def test_all_prices_missing_gives_none_average():
    records = [make_record(price_per_m2=None)]
    stats = compute_supplier_stats(records)
    assert stats[0].avg_price_per_m2 is None


def test_multiple_suppliers_grouped_and_sorted_by_last_request_desc():
    records = [
        make_record(supplier_id=1, supplier_name="Ранний", created_at=datetime(2026, 1, 1)),
        make_record(supplier_id=2, supplier_name="Поздний", created_at=datetime(2026, 2, 1)),
    ]
    stats = compute_supplier_stats(records)
    assert [s.supplier_name for s in stats] == ["Поздний", "Ранний"]
