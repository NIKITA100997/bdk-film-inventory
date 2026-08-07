from types import SimpleNamespace

from app.models.storage import RackType
from app.services.placement import _rule_matches, _rule_specificity, determine_rack_type


def make_sku(**overrides):
    defaults = dict(material_id=1, color_id=1, thickness_id=1, manufacturer_id=1, native_width_mm=None)
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def make_rule(**overrides):
    defaults = dict(material_id=None, color_id=None, thickness_id=None, manufacturer_id=None)
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class TestDetermineRackType:
    def test_matches_native_width_is_roll(self):
        sku = make_sku(native_width_mm=1400)
        assert determine_rack_type(sku, 1400, parent_id=None) == RackType.ROLL

    def test_narrower_than_native_width_is_strip(self):
        sku = make_sku(native_width_mm=1400)
        assert determine_rack_type(sku, 400, parent_id=5) == RackType.STRIP

    def test_no_native_width_falls_back_to_parent_id(self):
        sku = make_sku(native_width_mm=None)
        assert determine_rack_type(sku, 1400, parent_id=None) == RackType.ROLL
        assert determine_rack_type(sku, 400, parent_id=7) == RackType.STRIP


class TestRuleMatching:
    def test_wildcard_rule_matches_anything(self):
        sku = make_sku()
        assert _rule_matches(make_rule(), sku) is True

    def test_rule_with_wrong_material_does_not_match(self):
        sku = make_sku(material_id=1)
        assert _rule_matches(make_rule(material_id=2), sku) is False

    def test_specificity_counts_non_null_fields(self):
        assert _rule_specificity(make_rule()) == 0
        assert _rule_specificity(make_rule(material_id=1)) == 1
        assert _rule_specificity(make_rule(material_id=1, color_id=1)) == 2
        assert _rule_specificity(make_rule(material_id=1, color_id=1, thickness_id=1, manufacturer_id=1)) == 4
