from app.services.production import compute_remaining_length_m, compute_remaining_pieces


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
