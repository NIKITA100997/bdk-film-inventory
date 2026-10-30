from app.services.pf_demand import allocate_reserves, compute_suggestion, task_part_remaining


def test_reserve_capped_by_task_remaining():
    # резерв 100 на задание, которому осталось 60, — действует 60
    assert allocate_reserves(500, [(60, 100, 0)]) == [(60, 0, 0)]


def test_older_task_reserved_first_when_stock_short():
    assert allocate_reserves(70, [(50, 50, 0), (40, 40, 0)]) == [(50, 0, 0), (20, 0, 20)]


def test_work_under_task_covers_rest_of_shortage():
    # 30 в резерве, 50 делается под задание, не хватает 20
    assert allocate_reserves(30, [(100, 30, 50)]) == [(30, 50, 20)]


def test_no_reserve_means_nothing_allocated():
    assert allocate_reserves(500, [(40, 0, 0)]) == [(0, 0, 40)]


def test_below_min_stock_suggests_at_least_min_batch():
    need, shortage, suggested = compute_suggestion(task_demand=0, min_stock=100, stock=40, in_work=0, min_batch=200)
    assert (need, shortage, suggested) == (100, 60, 200)


def test_shortage_above_min_batch_is_taken_as_is():
    _, shortage, suggested = compute_suggestion(task_demand=300, min_stock=100, stock=50, in_work=0, min_batch=200)
    assert shortage == 350 and suggested == 350


def test_work_in_progress_prevents_duplicate_task():
    _, shortage, suggested = compute_suggestion(task_demand=0, min_stock=100, stock=40, in_work=200, min_batch=200)
    assert shortage == 0 and suggested == 0


def test_enough_stock_suggests_nothing():
    _, shortage, suggested = compute_suggestion(task_demand=50, min_stock=100, stock=150, in_work=0, min_batch=200)
    assert shortage == 0 and suggested == 0


def test_task_demand_without_min_stock():
    need, shortage, suggested = compute_suggestion(task_demand=80, min_stock=None, stock=30, in_work=0, min_batch=None)
    assert (need, shortage, suggested) == (80, 50, 50)


def test_overproduced_line_covers_sibling_lines_of_same_task():
    # строка 224: 395/443, 228: 5/53, соседние по нулям — задание закрыто
    assert task_part_remaining([(395, 443, False), (5, 53, False), (60, 0, False), (36, 0, False)]) == 0


def test_task_remaining_is_aggregated():
    assert task_part_remaining([(320, 2, False), (55, 0, False), (376, 179, False)]) == 570


def test_closed_line_plan_dropped_but_its_surplus_counts():
    # закрытая строка план 5, сделано 53 — 48 сверху идут соседней
    assert task_part_remaining([(5, 53, True), (60, 0, False)]) == 12


def test_closed_unproduced_line_not_demanded():
    assert task_part_remaining([(55, 0, True)]) == 0


def test_compute_pf_demand_stock_breakdown():
    from app.db.session import SessionLocal
    from app.services.pf_demand import compute_pf_demand

    db = SessionLocal()
    try:
        rows = compute_pf_demand(db)
        assert isinstance(rows, list)
        for r in rows:
            assert hasattr(r, "storage_stock")
            assert hasattr(r, "area_stock")
            assert hasattr(r, "target_areas")
            assert isinstance(r.target_areas, list)
            assert r.storage_stock >= 0
            assert r.area_stock >= 0
            for s in r.sources:
                assert hasattr(s, "area_stock")
                assert s.area_stock >= 0
    finally:
        db.close()


def test_produce_and_transfer_quick():
    from app.db.session import SessionLocal
    from app.models.dictionaries import Part
    from app.models.part_units import PartUnitStatus
    from app.models.users import User
    from app.services.part_units import produce_part_units_quick, transfer_part_units_to_area

    db = SessionLocal()
    try:
        part = db.query(Part).filter(Part.is_active.is_(True)).first()
        user = db.query(User).first()
        if not part or not user:
            return

        # 1. Быстрый выпуск на склад
        unit = produce_part_units_quick(
            db,
            part_id=part.id,
            quantity_pieces=15.0,
            user_id=user.id,
            note="Тестовый выпуск",
        )
        assert unit.id is not None
        assert float(unit.quantity_pieces) == 15.0
        assert unit.status == PartUnitStatus.NA_KHRANENII

        # 2. Перемещение на участок цеха
        transferred = transfer_part_units_to_area(
            db,
            part_id=part.id,
            quantity_pieces=10.0,
            target_area="okutka_tsargovykh",
            user_id=user.id,
            note="Тестовое перемещение",
        )
        assert len(transferred) >= 1
        assert sum(float(u.quantity_pieces) for u in transferred) == 10.0
        for u in transferred:
            assert u.status == PartUnitStatus.VYDAN_UCHASTKU
            assert u.area == "okutka_tsargovykh"
    finally:
        # Откатываем тестовую транзакцию, чтобы не оставлять мусор в БД
        db.rollback()
        db.close()

