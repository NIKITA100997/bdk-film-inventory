import datetime as dt

from app.services.defects_reports import (
    PivotInputRow,
    build_defect_pivot,
    bucket_date_range,
    defect_rate_percent,
    delta_percent,
)


class TestDeltaPercent:
    def test_increase(self):
        assert delta_percent(120, 100) == 20.0

    def test_decrease(self):
        assert delta_percent(80, 100) == -20.0

    def test_no_previous_data_is_none(self):
        assert delta_percent(50, 0) is None

    def test_no_change(self):
        assert delta_percent(100, 100) == 0.0


class TestDefectRatePercent:
    def test_typical(self):
        assert defect_rate_percent(defect_pieces=6, good_pieces=94) == 6.4

    def test_zero_good_pieces_is_zero_not_error(self):
        assert defect_rate_percent(defect_pieces=5, good_pieces=0) == 0.0

    def test_zero_defect(self):
        assert defect_rate_percent(defect_pieces=0, good_pieces=100) == 0.0


class TestBucketDateRange:
    def test_exact_multiple_of_bucket_size(self):
        buckets = bucket_date_range(dt.date(2026, 8, 1), dt.date(2026, 8, 14), bucket_days=7)
        assert buckets == [
            (dt.date(2026, 8, 1), dt.date(2026, 8, 7)),
            (dt.date(2026, 8, 8), dt.date(2026, 8, 14)),
        ]

    def test_last_bucket_is_shorter(self):
        buckets = bucket_date_range(dt.date(2026, 8, 1), dt.date(2026, 8, 9), bucket_days=7)
        assert buckets == [
            (dt.date(2026, 8, 1), dt.date(2026, 8, 7)),
            (dt.date(2026, 8, 8), dt.date(2026, 8, 9)),
        ]

    def test_period_shorter_than_bucket_is_single_bucket(self):
        buckets = bucket_date_range(dt.date(2026, 8, 1), dt.date(2026, 8, 3), bucket_days=7)
        assert buckets == [(dt.date(2026, 8, 1), dt.date(2026, 8, 3))]

    def test_inverted_range_is_empty(self):
        assert bucket_date_range(dt.date(2026, 8, 10), dt.date(2026, 8, 1)) == []


class TestBuildDefectPivot:
    def test_aggregates_by_group_and_reason(self):
        rows = [
            PivotInputRow("area_1", "Участок № 1", None, "Царапины", 6, 94),
            PivotInputRow("area_1", "Участок № 1", None, "Мусор", 3, 76),
            PivotInputRow("area_2", "Участок № 2", None, "Царапины", 2, 61),
        ]
        result = build_defect_pivot(rows)

        assert result.reasons == ["Царапины", "Мусор"]
        assert [g.group_label for g in result.rows] == ["Участок № 1", "Участок № 2"]

        area_1 = result.rows[0]
        assert area_1.defect_pieces == 9
        assert area_1.good_pieces == 170
        assert area_1.by_reason == {"Царапины": 6, "Мусор": 3}
        assert area_1.defect_rate_percent == round(9 / 170 * 100, 1)

    def test_sorted_worst_first(self):
        rows = [
            PivotInputRow("a", "A", None, "Причина", 2, 100),
            PivotInputRow("b", "B", None, "Причина", 10, 100),
        ]
        result = build_defect_pivot(rows)
        assert [g.group_label for g in result.rows] == ["B", "A"]

    def test_total_row_sums_across_groups(self):
        rows = [
            PivotInputRow("a", "A", None, "X", 4, 40),
            PivotInputRow("b", "B", None, "Y", 6, 60),
        ]
        result = build_defect_pivot(rows)
        assert result.total.defect_pieces == 10
        assert result.total.good_pieces == 100
        assert result.total.by_reason == {"X": 4, "Y": 6}
        assert result.total.defect_rate_percent == 10.0

    def test_report_without_defect_does_not_pollute_reason_columns(self):
        """Отчёт без брака (defect_pieces == 0) обычно и без причины — не
        должен создавать пустой столбец "Без причины" из одних нулей, но
        его good_pieces всё равно должен войти в знаменатель доли брака."""
        rows = [
            PivotInputRow("a", "A", None, None, 0, 50),
            PivotInputRow("a", "A", None, "Царапины", 5, 45),
        ]
        result = build_defect_pivot(rows)
        assert result.reasons == ["Царапины"]
        assert result.rows[0].good_pieces == 95
        assert result.rows[0].defect_pieces == 5

    def test_defect_without_explicit_reason_uses_fallback_label(self):
        rows = [PivotInputRow("a", "A", None, None, 3, 20)]
        result = build_defect_pivot(rows)
        assert result.reasons == ["Без причины"]
        assert result.rows[0].by_reason == {"Без причины": 3}

    def test_empty_input(self):
        result = build_defect_pivot([])
        assert result.reasons == []
        assert result.rows == []
        assert result.total.defect_pieces == 0
        assert result.total.good_pieces == 0
        assert result.total.defect_rate_percent == 0.0

    def test_line_rows_carry_parent_area_label(self):
        rows = [PivotInputRow("line_1", "Поперечная-1", "Участок № 1", "Царапины", 1, 10)]
        result = build_defect_pivot(rows)
        assert result.rows[0].parent_label == "Участок № 1"
