from app.services.production import compute_unit_consumed_length_m, report_film_m


def test_norm_when_no_meters():
    assert report_film_m(10, 2, 2.1) == 12 * 2.1


def test_actual_meters_override_norm():
    assert report_film_m(10, 2, 2.1, 26) == 26
    assert report_film_m(0, 2, 2.1, 0) == 0


def test_roll_consumption_mixes_both():
    assert compute_unit_consumed_length_m([(10, 0, 2.0), (5, 1, 2.0, 11.5)]) == 20 + 11.5
