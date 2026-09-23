from app.services.pf_demand import compute_suggestion


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
