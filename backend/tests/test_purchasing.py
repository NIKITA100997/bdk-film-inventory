from app.services.purchasing import OpenRequestGroup, ReorderInput, compute_reorder_signal, requests_closed_by_receipt


def test_matching_group_closed():
    open_requests = [OpenRequestGroup(1, material_id=10, color_id=20, thickness_id=30)]
    closed = requests_closed_by_receipt(open_requests, material_id=10, color_id=20, thickness_id=30)
    assert closed == [1]


def test_non_matching_group_left_open():
    open_requests = [OpenRequestGroup(1, material_id=10, color_id=20, thickness_id=30)]
    closed = requests_closed_by_receipt(open_requests, material_id=10, color_id=20, thickness_id=99)
    assert closed == []


def test_multiple_matches_all_closed():
    open_requests = [
        OpenRequestGroup(1, material_id=10, color_id=20, thickness_id=30),
        OpenRequestGroup(2, material_id=10, color_id=20, thickness_id=30),
        OpenRequestGroup(3, material_id=99, color_id=20, thickness_id=30),
    ]
    closed = requests_closed_by_receipt(open_requests, material_id=10, color_id=20, thickness_id=30)
    assert closed == [1, 2]


def test_empty_open_requests():
    assert requests_closed_by_receipt([], material_id=10, color_id=20, thickness_id=30) == []


def reorder_input(**overrides):
    defaults = dict(
        current_stock_m2=100.0,
        consumed_m2_in_window=30.0,
        lookback_days=30,
        avg_lead_time_days=5.0,
        safety_margin_days=7,
    )
    defaults.update(overrides)
    return ReorderInput(**defaults)


def test_no_consumption_gives_none_days_and_no_signal():
    signal = compute_reorder_signal(reorder_input(consumed_m2_in_window=0))
    assert signal.days_of_stock_remaining is None
    assert signal.reorder_suggested is False


def test_plenty_of_stock_no_reorder_signal():
    # 30 м²/30 дней = 1 м²/день, 100 м² остатка -> хватит на 100 дней,
    # намного больше, чем срок поставки (5) + запас (7) = 12.
    signal = compute_reorder_signal(reorder_input(current_stock_m2=100.0, consumed_m2_in_window=30.0))
    assert signal.days_of_stock_remaining == 100.0
    assert signal.reorder_suggested is False


def test_low_stock_within_lead_time_plus_margin_triggers_signal():
    # 30 м²/30 дней = 1 м²/день, 10 м² остатка -> хватит на 10 дней,
    # <= срок поставки (5) + запас (7) = 12 -> сигнал.
    signal = compute_reorder_signal(reorder_input(current_stock_m2=10.0, consumed_m2_in_window=30.0))
    assert signal.days_of_stock_remaining == 10.0
    assert signal.reorder_suggested is True


def test_no_lead_time_history_never_suggests_even_if_low_stock():
    signal = compute_reorder_signal(reorder_input(current_stock_m2=1.0, consumed_m2_in_window=30.0, avg_lead_time_days=None))
    assert signal.days_of_stock_remaining == 1.0
    assert signal.reorder_suggested is False


def test_exactly_at_threshold_triggers_signal():
    # days_remaining == lead_time + margin -> граница включительно ("успеем впритык" тоже сигнал).
    signal = compute_reorder_signal(
        reorder_input(current_stock_m2=12.0, consumed_m2_in_window=30.0, avg_lead_time_days=5.0, safety_margin_days=7)
    )
    assert signal.days_of_stock_remaining == 12.0
    assert signal.reorder_suggested is True
