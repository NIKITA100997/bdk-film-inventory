from app.services.smart_batching import plan_smart_batching, _count_changeovers, BatchingLineItem


def test_count_changeovers_empty_and_single():
    assert _count_changeovers([]) == 0
    item = BatchingLineItem(
        line_id=1, task_id=1, task_name="T1", part_name="P1",
        material_id=1, material_name="PVC", color_id=1, color_name="White",
        thickness_id=1, thickness_val=0.3, width_mm=200.0, length_m=10.0,
        remaining_pieces=5.0, due_date=None, urgency_score=1
    )
    assert _count_changeovers([item]) == 0


def test_count_changeovers_decor_and_width():
    item1 = BatchingLineItem(
        line_id=1, task_id=1, task_name="T1", part_name="P1",
        material_id=1, material_name="PVC", color_id=1, color_name="White",
        thickness_id=1, thickness_val=0.3, width_mm=200.0, length_m=10.0,
        remaining_pieces=5.0, due_date=None, urgency_score=1
    )
    # Same decor, small width delta <= 30mm: 0 changeovers
    item2 = BatchingLineItem(
        line_id=2, task_id=1, task_name="T1", part_name="P2",
        material_id=1, material_name="PVC", color_id=1, color_name="White",
        thickness_id=1, thickness_val=0.3, width_mm=220.0, length_m=10.0,
        remaining_pieces=5.0, due_date=None, urgency_score=1
    )
    assert _count_changeovers([item1, item2]) == 0

    # Same decor, large width delta > 30mm: 1 changeover
    item3 = BatchingLineItem(
        line_id=3, task_id=1, task_name="T1", part_name="P3",
        material_id=1, material_name="PVC", color_id=1, color_name="White",
        thickness_id=1, thickness_val=0.3, width_mm=300.0, length_m=10.0,
        remaining_pieces=5.0, due_date=None, urgency_score=1
    )
    assert _count_changeovers([item1, item3]) == 1

    # Different decor: 1 changeover
    item4 = BatchingLineItem(
        line_id=4, task_id=1, task_name="T1", part_name="P4",
        material_id=1, material_name="PVC", color_id=2, color_name="Black",
        thickness_id=1, thickness_val=0.3, width_mm=300.0, length_m=10.0,
        remaining_pieces=5.0, due_date=None, urgency_score=1
    )
    assert _count_changeovers([item3, item4]) == 1


def test_plan_smart_batching_db():
    from app.db.session import SessionLocal
    db = SessionLocal()
    try:
        res = plan_smart_batching(db, area="okutka_tsargovykh")
        assert res.area == "okutka_tsargovykh"
        assert res.changeovers_saved >= 0
        assert res.estimated_minutes_saved >= 0
        dct = res.to_dict()
        assert "total_lines" in dct
        assert "optimized_sequence" in dct
    finally:
        db.close()
