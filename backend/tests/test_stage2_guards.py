"""Tests for Stage 2: cutting_plan greedy fallback (>16 widths) and schema upper bounds."""

import time
import pytest
from pydantic import ValidationError

from app.schemas.production import ProductionTaskLineReportCreate
from app.schemas.units import ReceiveRequest, ReturnRequest
from app.services.cutting_plan import DonorCandidate, build_cutting_plan


def test_cutting_plan_handles_large_batch_quickly():
    # 25 widths would explode combinations(25, k) without greedy fallback
    widths = [100.0 + (i % 5) * 10.0 for i in range(25)]
    donors = [DonorCandidate(unit_id=1, width_mm=1250.0, length_m=500.0, days_in_storage=10)]
    t0 = time.perf_counter()
    plan = build_cutting_plan(widths, donors, min_useful_width_mm=50.0)
    elapsed = time.perf_counter() - t0
    assert elapsed < 0.2
    assert plan.donor is not None
    assert len(plan.covered_indices) >= 8
    total_w = sum(widths[i] for i in plan.covered_indices)
    assert total_w <= 1250.0 + 1e-9
    assert plan.waste_mm == 0 or plan.waste_mm >= 50.0


def test_schema_upper_and_lower_bounds():
    # Valid zero return length is allowed
    ret = ReturnRequest(actual_length_m=0.0)
    assert ret.actual_length_m == 0.0

    # Excessive return length rejected
    with pytest.raises(ValidationError):
        ReturnRequest(actual_length_m=60000.0)

    # Excessive width rejected
    with pytest.raises(ValidationError):
        ReceiveRequest(
            upd_number="1",
            pallet_number="1",
            material="ПВХ",
            color="Белый",
            thickness=0.3,
            manufacturer="Тест",
            width_mm=6000.0,
            length_m=100.0,
            quantity=1,
        )

    # Negative report pieces rejected
    with pytest.raises(ValidationError):
        ProductionTaskLineReportCreate(assignment_id=1, good_pieces=-1.0, defect_pieces=0.0)
