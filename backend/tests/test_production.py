from app.services.production import (
    BlankDemandInputLine,
    BlankSupplyInputLine,
    TaskLineForReserve,
    aggregate_blank_demand,
    calc_default_strip_width,
    compute_expected_return_length_m,
    compute_remaining_length_m,
    compute_remaining_pieces,
    compute_shortfall_length_m,
    reserved_area_m2_by_group,
)


class TestComputeRemainingPieces:
    """Раздел про брак в производстве — остаток строки задания после
    отчётов о факте производства."""

    def test_no_production_yet_remaining_equals_target(self):
        assert compute_remaining_pieces(500, 0) == 500

    def test_partial_production_reduces_remaining(self):
        assert compute_remaining_pieces(500, 400) == 100

    def test_full_production_leaves_zero_remaining(self):
        assert compute_remaining_pieces(500, 500) == 0

    def test_overproduction_does_not_go_negative(self):
        assert compute_remaining_pieces(500, 600) == 0


class TestComputeRemainingLengthM:
    """Раздел про размер детали — перевод остатка строки задания из штук в
    погонные метры плёнки через длину одной детали."""

    def test_translates_remaining_pieces_to_length(self):
        assert compute_remaining_length_m(2.4, 100) == 240

    def test_zero_remaining_pieces_gives_zero_length(self):
        assert compute_remaining_length_m(2.4, 0) == 0


class TestComputeExpectedReturnLengthM:
    """Раздел про возврат остатка — хорошие и бракованные детали одинаково
    списывают полную длину детали из выданной длины."""

    def test_no_production_yet_full_length_expected_back(self):
        assert compute_expected_return_length_m(100, 2.4, 0, 0) == 100

    def test_good_pieces_reduce_expected_return(self):
        assert compute_expected_return_length_m(100, 2.4, 10, 0) == 100 - 24

    def test_defect_pieces_also_reduce_expected_return(self):
        assert compute_expected_return_length_m(100, 2.4, 10, 5) == 100 - 24 - 12

    def test_does_not_go_negative_if_production_exceeds_issued_length(self):
        assert compute_expected_return_length_m(10, 2.4, 10, 0) == 0


class TestComputeShortfallLengthM:
    """Раздел про очередь «потребности» на выдаче участку — довыдача
    считается по нехватке уже выданной плёнки, не по остатку штук."""

    def test_nothing_issued_yet_full_plan_is_shortfall(self):
        assert compute_shortfall_length_m(100, 2.0, 0, 0) == 200

    def test_enough_issued_for_plan_no_shortfall(self):
        assert compute_shortfall_length_m(100, 2.0, 0, 200) == 0

    def test_issued_with_margin_still_no_shortfall(self):
        assert compute_shortfall_length_m(100, 2.0, 0, 250) == 0

    def test_defects_add_to_needed_length_beyond_plan(self):
        # план 200м, выдано ровно 200 — но случился брак 5 шт (=10м),
        # которые расходуют плёнку сверх исходного плана.
        assert compute_shortfall_length_m(100, 2.0, 5, 200) == 10

    def test_not_yet_reported_defect_keeps_shortfall_at_zero(self):
        # выдано меньше плана, но брака ещё не было отчёта — довыдача не
        # ждёт производство, она уже видна по голому недовыдатому плану.
        assert compute_shortfall_length_m(100, 2.0, 0, 150) == 50

    def test_does_not_go_negative(self):
        assert compute_shortfall_length_m(10, 2.0, 0, 1000) == 0


class TestCalcDefaultStripWidth:
    """Раздел про загрузку наряд-заказа — ширина плёнки на укутку по
    названию детали, константы сверены с формулами проекта Calc
    (interior_material_cost.py)."""

    def test_no_part_name_falls_back_to_wood_width(self):
        assert calc_default_strip_width(None, 150.0) == 150.0

    def test_stoevaya_is_fixed_292(self):
        assert calc_default_strip_width("Стоевая (МежКомн) 36х108х2000", 108.0) == 292.0

    def test_poperechnaya_is_fixed_285(self):
        assert calc_default_strip_width("Поперечная (МежКомн) 30х110х504", 110.0) == 285.0

    def test_filenka_known_width_163_maps_to_356(self):
        assert calc_default_strip_width("Филенка (МежКомн) 10х163х506", 163.0) == 356.0

    def test_filenka_known_width_220_maps_to_474(self):
        assert calc_default_strip_width("Филенка М-11", 220.0) == 474.0

    def test_filenka_unknown_width_uses_ratio_fallback(self):
        assert calc_default_strip_width("Филенка неизвестной модели", 200.0) == round(200.0 * 2.17, 1)

    def test_nalichnik_is_fixed_120(self):
        assert calc_default_strip_width("Наличник телескоп 8х70х2150", 70.0) == 120.0

    def test_dobor_adds_17mm(self):
        assert calc_default_strip_width("Добор телескоп 10х100х2070", 100.0) == 117.0

    def test_planka_wide_uses_140(self):
        assert calc_default_strip_width("Планка", 50.0) == 140.0

    def test_planka_narrow_uses_100(self):
        assert calc_default_strip_width("Планка", 30.0) == 100.0

    def test_unrecognized_part_name_falls_back_to_wood_width(self):
        assert calc_default_strip_width("Что-то незнакомое", 123.0) == 123.0


class TestReservedAreaM2ByGroup:
    """Раздел про экран снабженца ("Остатки и резерв") — сумма ещё не
    произведённой плёнки по группе материал+цвет+толщина, по всем строкам
    заданий сразу."""

    def test_single_line_reserve(self):
        line = TaskLineForReserve(
            material_id=1, color_id=2, thickness_id=3,
            quantity_pieces=100, produced_good_pieces=0,
            length_m=2.0, effective_strip_width_mm=300,
        )
        # remaining_pieces=100, remaining_length_m=200, area=300/1000*200=60
        assert reserved_area_m2_by_group([line]) == {(1, 2, 3): 60.0}

    def test_multiple_lines_same_group_sum(self):
        line_a = TaskLineForReserve(1, 2, 3, 100, 0, 2.0, 300)  # 60 м²
        line_b = TaskLineForReserve(1, 2, 3, 50, 0, 2.0, 300)  # 30 м²
        assert reserved_area_m2_by_group([line_a, line_b]) == {(1, 2, 3): 90.0}

    def test_different_groups_not_mixed(self):
        line_a = TaskLineForReserve(1, 2, 3, 100, 0, 2.0, 300)
        line_b = TaskLineForReserve(9, 9, 9, 100, 0, 2.0, 300)
        result = reserved_area_m2_by_group([line_a, line_b])
        assert result == {(1, 2, 3): 60.0, (9, 9, 9): 60.0}

    def test_fully_produced_line_contributes_no_reserve(self):
        line = TaskLineForReserve(1, 2, 3, 100, 100, 2.0, 300)
        assert reserved_area_m2_by_group([line]) == {}

    def test_empty_lines_gives_empty_result(self):
        assert reserved_area_m2_by_group([]) == {}


class TestAggregateBlankDemand:
    """Раздел про «Заготовки» — резать в ширину заранее, до того как
    задания реально распределены и за ними «пришли»."""

    def test_deficit_when_needed_exceeds_on_hand(self):
        demand = [BlankDemandInputLine(1, 2, 3, 292, 500)]
        supply = [BlankSupplyInputLine(1, 2, 3, 292, 200)]
        rows = aggregate_blank_demand(demand, supply)
        assert len(rows) == 1
        row = rows[0]
        assert (row.material_id, row.color_id, row.thickness_id, row.width_mm) == (1, 2, 3, 292)
        assert row.needed_length_m == 500
        assert row.on_hand_length_m == 200
        assert row.deficit_length_m == 300

    def test_surplus_when_on_hand_exceeds_needed(self):
        demand = [BlankDemandInputLine(1, 2, 3, 292, 100)]
        supply = [BlankSupplyInputLine(1, 2, 3, 292, 400)]
        row = aggregate_blank_demand(demand, supply)[0]
        assert row.deficit_length_m == -300

    def test_sums_multiple_demand_lines_same_width(self):
        demand = [
            BlankDemandInputLine(1, 2, 3, 292, 100),
            BlankDemandInputLine(1, 2, 3, 292, 250),
        ]
        row = aggregate_blank_demand(demand, [])[0]
        assert row.needed_length_m == 350
        assert row.on_hand_length_m == 0

    def test_sums_multiple_supply_units_same_width(self):
        supply = [
            BlankSupplyInputLine(1, 2, 3, 292, 40),
            BlankSupplyInputLine(1, 2, 3, 292, 60),
        ]
        row = aggregate_blank_demand([], supply)[0]
        assert row.on_hand_length_m == 100
        assert row.needed_length_m == 0
        assert row.deficit_length_m == -100

    def test_different_widths_not_mixed(self):
        demand = [BlankDemandInputLine(1, 2, 3, 292, 100), BlankDemandInputLine(1, 2, 3, 285, 50)]
        supply = [BlankSupplyInputLine(1, 2, 3, 292, 20)]
        rows = {r.width_mm: r for r in aggregate_blank_demand(demand, supply)}
        assert rows[292].needed_length_m == 100
        assert rows[292].on_hand_length_m == 20
        assert rows[285].needed_length_m == 50
        assert rows[285].on_hand_length_m == 0

    def test_different_materials_not_mixed_even_at_same_width(self):
        demand = [BlankDemandInputLine(1, 2, 3, 292, 100), BlankDemandInputLine(9, 9, 9, 292, 200)]
        rows = {(r.material_id, r.color_id, r.thickness_id): r for r in aggregate_blank_demand(demand, [])}
        assert rows[(1, 2, 3)].needed_length_m == 100
        assert rows[(9, 9, 9)].needed_length_m == 200

    def test_sorted_worst_deficit_first(self):
        demand = [BlankDemandInputLine(1, 1, 1, 100, 50), BlankDemandInputLine(2, 2, 2, 200, 500)]
        rows = aggregate_blank_demand(demand, [])
        assert [r.width_mm for r in rows] == [200, 100]

    def test_empty_input_gives_empty_result(self):
        assert aggregate_blank_demand([], []) == []
