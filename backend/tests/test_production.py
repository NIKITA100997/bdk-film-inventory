from app.services.production import BomPart, explode_task


def test_empty_parts_returns_empty_list():
    assert explode_task([], 500) == []


def test_single_part_multiplies_by_quantity():
    parts = [BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=2)]
    result = explode_task(parts, 500)
    assert len(result) == 1
    line = result[0]
    assert line.line_id == 1
    assert line.quantity_pieces == 1000


def test_parts_on_different_lines_produce_separate_rows():
    parts = [
        BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=2),
        BomPart(line_id=2, material_id=10, color_id=20, thickness_id=30, qty_per_unit=2),
    ]
    result = explode_task(parts, 500)
    by_line = {r.line_id: r.quantity_pieces for r in result}
    assert by_line == {1: 1000, 2: 1000}


def test_parts_on_same_line_and_film_are_summed():
    parts = [
        BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=2),
        BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=1),
    ]
    result = explode_task(parts, 500)
    assert len(result) == 1
    assert result[0].quantity_pieces == 1500  # (2 + 1) * 500


def test_same_line_different_color_stays_separate():
    parts = [
        BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=2),
        BomPart(line_id=1, material_id=10, color_id=99, thickness_id=30, qty_per_unit=1),
    ]
    result = explode_task(parts, 500)
    assert len(result) == 2
    by_color = {r.color_id: r.quantity_pieces for r in result}
    assert by_color == {20: 1000, 99: 500}


def test_zero_quantity_gives_zero_pieces_but_keeps_rows():
    parts = [BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=2)]
    result = explode_task(parts, 0)
    assert result[0].quantity_pieces == 0
