from app.services.production import BomPart, compute_remaining_length_m, compute_remaining_pieces, explode_task


def test_empty_parts_returns_empty_list():
    assert explode_task([], 500) == []


def test_single_part_multiplies_by_quantity():
    parts = [BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=2, width_mm=120, length_m=2.4)]
    result = explode_task(parts, 500)
    assert len(result) == 1
    line = result[0]
    assert line.line_id == 1
    assert line.quantity_pieces == 1000
    assert line.width_mm == 120
    assert line.length_m == 2.4


def test_parts_on_different_lines_produce_separate_rows():
    parts = [
        BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=2, width_mm=120, length_m=2.4),
        BomPart(line_id=2, material_id=10, color_id=20, thickness_id=30, qty_per_unit=2, width_mm=120, length_m=2.4),
    ]
    result = explode_task(parts, 500)
    by_line = {r.line_id: r.quantity_pieces for r in result}
    assert by_line == {1: 1000, 2: 1000}


def test_parts_on_same_line_film_and_size_are_summed():
    parts = [
        BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=2, width_mm=120, length_m=2.4),
        BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=1, width_mm=120, length_m=2.4),
    ]
    result = explode_task(parts, 500)
    assert len(result) == 1
    assert result[0].quantity_pieces == 1500  # (2 + 1) * 500


def test_same_line_different_color_stays_separate():
    parts = [
        BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=2, width_mm=120, length_m=2.4),
        BomPart(line_id=1, material_id=10, color_id=99, thickness_id=30, qty_per_unit=1, width_mm=120, length_m=2.4),
    ]
    result = explode_task(parts, 500)
    assert len(result) == 2
    by_color = {r.color_id: r.quantity_pieces for r in result}
    assert by_color == {20: 1000, 99: 500}


def test_same_line_and_film_different_size_stays_separate():
    """Раздел про размер детали — одна и та же плёнка, но другой размер
    реза, это другая заготовка, не должна сливаться в одну строку."""
    parts = [
        BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=2, width_mm=120, length_m=2.4),
        BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=1, width_mm=200, length_m=1.2),
    ]
    result = explode_task(parts, 500)
    assert len(result) == 2
    by_size = {(r.width_mm, r.length_m): r.quantity_pieces for r in result}
    assert by_size == {(120, 2.4): 1000, (200, 1.2): 500}


def test_zero_quantity_gives_zero_pieces_but_keeps_rows():
    parts = [BomPart(line_id=1, material_id=10, color_id=20, thickness_id=30, qty_per_unit=2, width_mm=120, length_m=2.4)]
    result = explode_task(parts, 0)
    assert result[0].quantity_pieces == 0


class TestComputeRemainingPieces:
    """Раздел про брак в производстве — остаток строки задания после
    отчётов о факте производства."""

    def test_no_production_yet_remaining_equals_target(self):
        assert compute_remaining_pieces(500, 0) == 500

    def test_partial_production_reduces_remaining(self):
        assert compute_remaining_pieces(500, 400) == 100

    def test_full_production_leaves_zero_remaining(self):
        assert compute_remaining_pieces(500, 500) == 0

    def test_overproduction_does_not_go_negative(self):
        assert compute_remaining_pieces(500, 600) == 0


class TestComputeRemainingLengthM:
    """Раздел про размер детали — перевод остатка строки задания из штук в
    погонные метры плёнки через длину одной детали."""

    def test_translates_remaining_pieces_to_length(self):
        assert compute_remaining_length_m(2.4, 100) == 240

    def test_zero_remaining_pieces_gives_zero_length(self):
        assert compute_remaining_length_m(2.4, 0) == 0
