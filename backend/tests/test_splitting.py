import pytest

from app.models.events import EventType
from app.models.units import MaterialUnit, UnitStatus
from app.services.splitting import cut_to_length, split_lengthwise


def make_unit(**overrides) -> MaterialUnit:
    defaults = dict(
        id=1,
        parent_id=None,
        upd_number="UPD-1",
        pallet_number="1",
        material="ПВХ",
        color="Дуб сонома",
        thickness=0.4,
        manufacturer="Аляска",
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
        assert outcome.new_unit.material == unit.material
        assert outcome.new_unit.color == unit.color
        assert outcome.new_unit.thickness == unit.thickness
        assert outcome.new_unit.manufacturer == unit.manufacturer
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
