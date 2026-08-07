from app.models.abc import WidthClass
from app.services.abc_analysis import WidthUsage, classify_widths


def test_empty_usage_gives_empty_result():
    assert classify_widths([]) == []


def test_single_width_is_always_class_a():
    result = classify_widths([WidthUsage(1000, 50)])
    assert len(result) == 1
    assert result[0].width_class == WidthClass.A


def test_top_80_percent_is_a_next_15_is_b_rest_is_c():
    # 500/300/150/50 из 1000 суммарно = 50%/30%/15%/5%
    usage = [
        WidthUsage(1000, 500),
        WidthUsage(850, 300),
        WidthUsage(400, 150),
        WidthUsage(220, 50),
    ]
    result = {c.width_mm: c.width_class for c in classify_widths(usage)}
    assert result[1000] == WidthClass.A  # cumulative 50%
    assert result[850] == WidthClass.A  # cumulative 80% — на границе, включительно A
    assert result[400] == WidthClass.B  # cumulative 95%
    assert result[220] == WidthClass.C  # cumulative 100%


def test_classification_independent_of_input_order():
    usage = [WidthUsage(220, 50), WidthUsage(1000, 500), WidthUsage(400, 150), WidthUsage(850, 300)]
    result = {c.width_mm: c.width_class for c in classify_widths(usage)}
    assert result[1000] == WidthClass.A
    assert result[220] == WidthClass.C
