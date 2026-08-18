import pytest

from app.models.events import EventType
from app.models.units import MaterialUnit, UnitStatus
from app.services.splitting import cut_to_length, split_lengthwise, split_lengthwise_multi


def make_unit(**overrides) -> MaterialUnit:
    defaults = dict(
        id=1,
        parent_id=None,
        upd_number="UPD-1",
        pallet_number="1",
        material_sku_id=42,
        width_mm=1400,
        length_m=500,
        status=UnitStatus.NA_KHRANENII,
        area=None,
        location_code="Р-3-07",
    )
    defaults.update(overrides)
    return MaterialUnit(**defaults)


class TestSplitLengthwise:
    def test_remaining_part_keeps_same_length_and_id(self):
        unit = make_unit(width_mm=1400, length_m=500)
        outcome = split_lengthwise(unit, separate_width_mm=400, new_unit_location="Ш-2-04-06")

        assert outcome.parent_width_mm == 1000
        assert outcome.parent_length_m == 500  # длина продолжения не меняется
        assert outcome.parent_event.unit_id == unit.id  # "продолжение" — тот же ID

        assert outcome.new_unit is not None
        assert outcome.new_unit.parent_id == unit.id
        assert outcome.new_unit.width_mm == 400
        assert outcome.new_unit.length_m == 500  # длина у обеих частей одинаковая
        assert outcome.new_unit.location_code == "Ш-2-04-06"
        assert outcome.new_unit.status == UnitStatus.NA_KHRANENII

    def test_material_attrs_inherited_by_new_unit(self):
        unit = make_unit()
        outcome = split_lengthwise(unit, separate_width_mm=400)
        assert outcome.new_unit.material_sku_id == unit.material_sku_id
        assert outcome.new_unit.upd_number == unit.upd_number  # партионность (2.5)

    def test_events_recorded_for_both_parts(self):
        unit = make_unit()
        outcome = split_lengthwise(unit, separate_width_mm=400)
        assert outcome.parent_event.event_type == EventType.PRODOLNAYA_REZKA
        assert outcome.new_unit_event.event_type == EventType.PRODOLNAYA_REZKA
        assert outcome.new_unit_event.quantity_delta_m == 500  # новая единица длиной 500 м появилась в учёте

    def test_rejects_zero_or_negative_width(self):
        unit = make_unit(width_mm=1400)
        with pytest.raises(ValueError):
            split_lengthwise(unit, separate_width_mm=0)
        with pytest.raises(ValueError):
            split_lengthwise(unit, separate_width_mm=-10)

    def test_rejects_width_not_smaller_than_current(self):
        unit = make_unit(width_mm=1400)
        with pytest.raises(ValueError):
            split_lengthwise(unit, separate_width_mm=1400)
        with pytest.raises(ValueError):
            split_lengthwise(unit, separate_width_mm=1500)


class TestSplitLengthwiseMulti:
    def test_happy_path_three_pieces_with_leftover(self):
        unit = make_unit(width_mm=620, length_m=500)
        outcome = split_lengthwise_multi(unit, [150, 200, 165])

        assert outcome.parent_width_mm == 105  # 620 - (150+200+165)
        assert outcome.parent_length_m == 500  # длина донора не меняется
        assert outcome.parent_status == UnitStatus.NA_KHRANENII

        assert [u.width_mm for u in outcome.new_units] == [150, 200, 165]
        assert all(u.length_m == 500 for u in outcome.new_units)  # теоретическая длина = длина донора
        assert all(u.parent_id == unit.id for u in outcome.new_units)
        assert all(u.material_sku_id == unit.material_sku_id for u in outcome.new_units)
        assert all(u.status == UnitStatus.NA_KHRANENII for u in outcome.new_units)

    def test_exact_fit_leaves_zero_leftover(self):
        unit = make_unit(width_mm=515)
        outcome = split_lengthwise_multi(unit, [150, 200, 165])
        assert outcome.parent_width_mm == 0

    def test_events_recorded_for_parent_and_each_piece(self):
        unit = make_unit(width_mm=620, length_m=500)
        outcome = split_lengthwise_multi(unit, [150, 200])
        assert outcome.parent_event.event_type == EventType.PRODOLNAYA_REZKA
        assert outcome.parent_event.unit_id == unit.id
        assert len(outcome.new_unit_events) == 2
        assert all(e.event_type == EventType.PRODOLNAYA_REZKA for e in outcome.new_unit_events)
        assert [e.width_mm for e in outcome.new_unit_events] == [150, 200]
        assert all(e.quantity_delta_m == 500 for e in outcome.new_unit_events)

    def test_rejects_empty_widths_list(self):
        unit = make_unit(width_mm=620)
        with pytest.raises(ValueError):
            split_lengthwise_multi(unit, [])

    def test_rejects_zero_or_negative_width(self):
        unit = make_unit(width_mm=620)
        with pytest.raises(ValueError):
            split_lengthwise_multi(unit, [150, 0])
        with pytest.raises(ValueError):
            split_lengthwise_multi(unit, [150, -10])

    def test_rejects_sum_exceeding_donor_width(self):
        unit = make_unit(width_mm=300)
        with pytest.raises(ValueError):
            split_lengthwise_multi(unit, [150, 200])


class TestCutToLength:
    def test_remainder_keeps_same_id_and_width(self):
        unit = make_unit(width_mm=1400, length_m=500)
        outcome = cut_to_length(unit, cut_length_m=120, remainder_location="Б-1-02")

        assert outcome.parent_width_mm == 1400  # ширина не меняется при раскрое по длине
        assert outcome.parent_length_m == 380
        assert outcome.new_unit is None  # отрезанный кусок сразу списывается, новая единица не создаётся
        assert outcome.parent_event.event_type == EventType.RASKROY
        assert outcome.parent_event.quantity_delta_m == -120
        assert outcome.parent_status == UnitStatus.NA_KHRANENII

    def test_full_consumption_marks_unit_disposed(self):
        unit = make_unit(length_m=120)
        outcome = cut_to_length(unit, cut_length_m=120)
        assert outcome.parent_length_m == 0
        assert outcome.parent_status == UnitStatus.SPISAN

    def test_rejects_cut_longer_than_available(self):
        unit = make_unit(length_m=100)
        with pytest.raises(ValueError):
            cut_to_length(unit, cut_length_m=150)

    def test_rejects_zero_or_negative_length(self):
        unit = make_unit(length_m=100)
        with pytest.raises(ValueError):
            cut_to_length(unit, cut_length_m=0)
        with pytest.raises(ValueError):
            cut_to_length(unit, cut_length_m=-5)
