from app.models.items import Item, ItemType
from app.services.item_attrs import default_mode, effective_mode


def test_default_mode_by_direction_and_stage():
    assert default_mode("pf", "shield", "blank") == "order"
    assert default_mode("pf", "panel", "bare") == "order"
    assert default_mode("pf", "tsarg", "laminated") == "order"
    assert default_mode("pf", "trim", "laminated") == "order"
    assert default_mode("pf", "tsarg", "bare") == "stock"
    assert default_mode("pf", "trim", "bare") == "stock"
    assert default_mode("pf", "tsarg", "stripped") == "stock"
    assert default_mode("izdelie", "tsarg", None) == "order"
    assert default_mode("plenka", None, None) is None
    assert default_mode("material", None, None) is None


def test_item_overrides_type_and_rule():
    t = ItemType(direction="tsarg", stage="bare")
    item = Item()
    assert effective_mode(item, "pf", t) == "stock"
    item.stage = "laminated"
    assert effective_mode(item, "pf", t) == "order"
    item.make_mode = "stock"
    assert effective_mode(item, "pf", t) == "stock"
