"""Tests for Stage 3: extracted reconciliation service and boundary production math."""

from app.db.session import SessionLocal
from app.models.units import MaterialUnit
from app.services.production import (
    GroupShortfallLine,
    compute_remaining_length_m,
    compute_remaining_pieces,
    compute_shortfall_length_m,
    distribute_group_shortfall,
)
from app.services.reconciliation import list_reconciliation_rows


def test_production_math_boundary_cases():
    # Zero production
    assert compute_remaining_pieces(10.0, 0.0) == 10.0
    # Overproduction never goes negative
    assert compute_remaining_pieces(10.0, 14.5) == 0.0
    assert compute_remaining_length_m(2.15, 0.0) == 0.0
    # Fractional length rounding
    assert compute_remaining_length_m(2.13, 3.0) == 6.39

    # Shortfall with defects and over-issue
    assert compute_shortfall_length_m(10.0, 2.0, 1.5, 25.0) == 0.0
    assert compute_shortfall_length_m(10.0, 2.0, 1.5, 20.0) == 3.0

    # Group shortfall ignores closed lines for shortfall, keeps their issued meters
    lines = [
        GroupShortfallLine(line_id=1, width_key=100.0, needed_length_m=20.0, issued_length_m=10.0, is_closed=False),
        GroupShortfallLine(line_id=2, width_key=100.0, needed_length_m=30.0, issued_length_m=15.0, is_closed=True),
    ]
    res = distribute_group_shortfall(lines)
    # group_needed = 20 (line 2 is closed), group_issued = 25 -> shortfall 0
    assert res == {1: 0.0, 2: 0.0}


def test_list_reconciliation_rows_service():
    db = SessionLocal()
    try:
        rows = list_reconciliation_rows(db)
        assert isinstance(rows, list)
        u = db.query(MaterialUnit).first()
        if u is not None:
            single = list_reconciliation_rows(db, unit_id=u.id)
            assert len(single) == 1
            assert single[0].unit_id == u.id
    finally:
        db.close()
