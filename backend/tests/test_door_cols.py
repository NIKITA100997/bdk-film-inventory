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


def test_door_cols_moldings_and_color_extraction():
    # 1. Door with molding in name: size must be 800х2000, not 5х3!
    d1 = door_cols([], "Е-10.2 (м5х3 кромка 4х под ПЭТ) 800х2000 - ПЭТ Белый (Защелка Border room) кромка Black Молдинг 5х3 мм черный")
    assert d1["series"] == "Е-10.2"
    assert d1["size"] == "800х2000"
    assert d1["color"] == "ПЭТ Белый"

    # 2. Door with Russian color and letter 'ё' in decor name
    d2 = door_cols([], "В-15 (м9 кромка 4х) 600х2000 - Бетон тёмный ВДМ (Защелка Border room) кромка черная ABS 2мм")
    assert d2["series"] == "В-15"
    assert d2["size"] == "600х2000"
    assert d2["color"] == "Бетон тёмный ВДМ"

    # 3. Door with decor without PET/PVC keyword
    d3 = door_cols([], "В-12 кромка с 2-х сторон 600х2000 - Дуб арктик горизонт (стекло Черное) кромка черная ABS 2мм")
    assert d3["series"] == "В-12"
    assert d3["size"] == "600х2000"
    assert d3["color"] == "Дуб арктик горизонт"

    # 4. Repeated color deduplication
    d4 = door_cols([], "Е-40 Полотно щитовое 4-х стороннее кромление 700х2000 - Белый матовый EVO Белый матовый EVO")
    assert d4["series"] == "Е-40"
    assert d4["size"] == "700х2000"
    assert d4["color"] == "Белый матовый EVO"

