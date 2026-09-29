from types import SimpleNamespace

from app.services.sku_matching import narrow_by_pet


def sku(material: str, color: str):
    return SimpleNamespace(material=SimpleNamespace(name=material), color=SimpleNamespace(name=color))


def test_picks_pet_of_the_part():
    cands = [sku("ПЭТ 3Д", "Бежевый"), sku("ПЭТ 2Д", "Бежевый")]
    assert narrow_by_pet(cands, "2d", "ПЭТ Бежевый (cream silk)") is cands[1]
    assert narrow_by_pet(cands, "3d", "ПЭТ Бежевый (cream silk)") is cands[0]


def test_ignores_neighbour_colors():
    cands = [sku("ПЭТ 3Д", "Белый"), sku("ПЭТ 2Д", "Белый"), sku("ПВХ", "Эмалит Белый"), sku("ПЭТ 2Д", "Бежевый")]
    assert narrow_by_pet(cands, "2d", "ПЭТ Белый") is cands[1]


def test_no_part_or_no_pet_leaves_choice_to_human():
    cands = [sku("ПВХ", "Бетон"), sku("ПВХ", "Бетон тёмный")]
    assert narrow_by_pet(cands, "2d", "Бетон") is None
    assert narrow_by_pet([sku("ПЭТ 3Д", "Белый"), sku("ПЭТ 2Д", "Белый")], None, "ПЭТ Белый") is None
