from app.services.cutting_plan import DonorCandidate, build_cutting_plan


class TestBuildCuttingPlan:
    def test_no_donors_leaves_everything_uncovered(self):
        plan = build_cutting_plan([150, 200], [], min_useful_width_mm=52)
        assert plan.donor is None
        assert plan.covered_indices == []

    def test_single_donor_covers_all_needs_with_zero_waste(self):
        donor = DonorCandidate(unit_id=1, width_mm=515, length_m=500)
        plan = build_cutting_plan([150, 200, 165], [donor], min_useful_width_mm=52)
        assert plan.donor is donor
        assert sorted(plan.covered_indices) == [0, 1, 2]
        assert plan.waste_mm == 0

    def test_prefers_donor_covering_more_needs_even_with_more_waste(self):
        # Донор A закрывает все 3 потребности (515 + отход 55, что не ниже
        # порога), донор B закрывает только 2 из 3 идеально (0 отхода) — по
        # числу закрытых потребностей A лучше, несмотря на ненулевой остаток.
        donor_a = DonorCandidate(unit_id=1, width_mm=570, length_m=500)  # 150+200+165=515, отход 55
        donor_b = DonorCandidate(unit_id=2, width_mm=350, length_m=500)  # 150+200=350, отход 0
        plan = build_cutting_plan([150, 200, 165], [donor_a, donor_b], min_useful_width_mm=52)
        assert plan.donor is donor_a
        assert sorted(plan.covered_indices) == [0, 1, 2]

    def test_rejects_leftover_below_min_useful_width(self):
        # Донор шириной 302 может закрыть все три потребности по 100мм
        # (300 + отход 2 — ниже порога 52, запрещённый обрезок) ИЛИ
        # откатиться до пары (200 + отход 102, годится) — ожидаем именно её.
        donor = DonorCandidate(unit_id=1, width_mm=302, length_m=500)
        plan = build_cutting_plan([100, 100, 100], [donor], min_useful_width_mm=52)
        assert len(plan.covered_indices) == 2
        assert plan.waste_mm == 102

    def test_zero_leftover_always_allowed_even_below_min_useful_width(self):
        donor = DonorCandidate(unit_id=1, width_mm=350, length_m=500)
        plan = build_cutting_plan([150, 200], [donor], min_useful_width_mm=52)
        assert sorted(plan.covered_indices) == [0, 1]
        assert plan.waste_mm == 0

    def test_donor_too_narrow_for_any_need_is_skipped(self):
        donor = DonorCandidate(unit_id=1, width_mm=100, length_m=500)
        plan = build_cutting_plan([150, 200], [donor], min_useful_width_mm=52)
        assert plan.donor is None
        assert plan.covered_indices == []

    def test_picks_oldest_donor_when_tied_on_coverage_and_waste(self):
        older = DonorCandidate(unit_id=1, width_mm=350, length_m=500, days_in_storage=30)
        newer = DonorCandidate(unit_id=2, width_mm=350, length_m=500, days_in_storage=2)
        plan = build_cutting_plan([150, 200], [newer, older], min_useful_width_mm=52)
        assert plan.donor is older

    def test_duplicate_needed_widths_each_get_own_index(self):
        donor = DonorCandidate(unit_id=1, width_mm=300, length_m=500)
        plan = build_cutting_plan([150, 150], [donor], min_useful_width_mm=52)
        assert sorted(plan.covered_indices) == [0, 1]
        assert plan.waste_mm == 0
