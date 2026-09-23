from app.services.shield_parts import (
    frame_part_name,
    laminated_panel_part_name,
    raw_panel_part_name,
    shield_footprint,
)


def test_footprint_is_door_plus_10():
    assert shield_footprint(800, 2000) == (810, 2010)


def test_frame_name_matches_schedule_notation():
    assert frame_part_name(810, 2010, 24) == "Каркас 810х2010х24"


def test_frame_name_keeps_fractional_thickness():
    assert frame_part_name(610, 2010, 21.5) == "Каркас 610х2010х21.5"


def test_raw_panel_name_matches_schedule_notation():
    assert raw_panel_part_name(810, 2010, 6) == "Панель 6х810х2010"


def test_laminated_panel_name_normalizes_color_spaces():
    assert laminated_panel_part_name(810, 2010, 8, " ПЭТ  Бежевый ") == "Панель 8х810х2010 ПЭТ Бежевый"
