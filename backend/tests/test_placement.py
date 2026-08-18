from types import SimpleNamespace

from app.models.storage import RackType
from app.services.placement import rule_matches, _rule_specificity, determine_rack_type


def make_sku(**overrides):
    defaults = dict(material_id=1, color_id=1, thickness_id=1, manufacturer_id=1, native_width_mm=None)
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def make_rule(**overrides):
    defaults = dict(material_id=None, color_id=None, thickness_id=None, manufacturer_id=None)
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class TestDetermineRackType:
    def test_not_strip_is_roll(self):
        assert determine_rack_type(False) == RackType.ROLL

    def test_strip_is_strip(self):
        assert determine_rack_type(True) == RackType.STRIP


class TestRuleMatching:
    def test_wildcard_rule_matches_anything(self):
        sku = make_sku()
        assert rule_matches(make_rule(), sku) is True

    def test_rule_with_wrong_material_does_not_match(self):
        sku = make_sku(material_id=1)
        assert rule_matches(make_rule(material_id=2), sku) is False

    def test_specificity_counts_non_null_fields(self):
        assert _rule_specificity(make_rule()) == 0
        assert _rule_specificity(make_rule(material_id=1)) == 1
        assert _rule_specificity(make_rule(material_id=1, color_id=1)) == 2
        assert _rule_specificity(make_rule(material_id=1, color_id=1, thickness_id=1, manufacturer_id=1)) == 4
