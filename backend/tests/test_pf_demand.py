from app.services.pf_demand import compute_suggestion, task_part_remaining


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
