from app.services.plan_fact import aggregate_actual


def test_empty_events_gives_zero():
    result = aggregate_actual([])
    assert result.total_area_m2 == 0
    assert result.by_width == {}


def test_single_event_computes_area():
    # 1000 мм × 40 м = 40 м²
    result = aggregate_actual([(1000, -40)])
    assert result.total_area_m2 == 40
    assert result.by_width == {1000: 40}


def test_multiple_widths_sum_and_break_down_separately():
    result = aggregate_actual([(1000, -40), (850, -20), (1000, -10)])
    # (1000*40 + 850*20 + 1000*10) / 1000 = (40000+17000+10000)/1000
    assert result.total_area_m2 == 67
    assert result.by_width == {1000: 50, 850: 20}


def test_uses_absolute_value_regardless_of_sign():
    result = aggregate_actual([(1000, 40)])
    assert result.total_area_m2 == 40
