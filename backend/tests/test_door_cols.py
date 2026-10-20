from app.services.door_cols import door_cols


def _chars(kind: str, color: str) -> list[dict]:
    return [{"code": "кромка", "value": kind}, {"code": "цвет_кромки", "value": color}]


def test_edge_columns_abs_four_sides():
    d = door_cols(_chars("abs", "черная ABS 2мм"), "В-15 (м9 кромка 4х) 800х2000 - Аляска кромка черная ABS 2мм")
    assert (d["edge_type"], d["edge_color"], d["edge_sides"]) == ("ABS 2 мм", "черная", 4)
    assert d["edge"] == "ABS 2 мм, черная"


def test_edge_columns_pet_two_sides():
    d = door_cols(_chars("abs", "ПЭТ Бежевая 1мм"), "В-12 кромка с 2-х сторон 700х2000 - Дуб арктик")
    assert (d["edge_type"], d["edge_color"], d["edge_sides"]) == ("ПЭТ 1 мм", "Бежевая", 2)


def test_edge_columns_unknown_thickness_and_sides():
    d = door_cols(_chars("abs", "черная ABS"), "В-5 800х2000")
    assert d["edge_type"] == "ABS — толщина?"
    assert d["edge_sides"] is None


def test_edge_columns_aluminium():
    d = door_cols(_chars("aluminum", "Black"), None)
    assert (d["edge_type"], d["edge_color"]) == ("алюминий", "Black")
