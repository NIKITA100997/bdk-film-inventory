from app.models.users import Area
from app.services.users import area_is_missing, resolve_area


def test_resolve_area_none_for_non_uchastka_role():
    assert resolve_area({"logist"}, Area.OKUTKA_TSARGOVYKH) is None


def test_resolve_area_uses_requested_for_uchastka():
    assert resolve_area({"nachalnik_uchastka"}, Area.SHCHITOVYE_DVERI) == Area.SHCHITOVYE_DVERI


def test_resolve_area_falls_back_to_existing_when_not_requested():
    assert (
        resolve_area({"nachalnik_uchastka"}, None, existing_area=Area.TSELNOLISTOVYE_DVERI)
        == Area.TSELNOLISTOVYE_DVERI
    )


def test_resolve_area_none_when_neither_requested_nor_existing():
    assert resolve_area({"nachalnik_uchastka"}, None, existing_area=None) is None


def test_area_is_missing_true_for_uchastka_without_area():
    assert area_is_missing({"nachalnik_uchastka"}, None) is True


def test_area_is_missing_false_for_uchastka_with_area():
    assert area_is_missing({"nachalnik_uchastka"}, Area.OKUTKA_TSARGOVYKH) is False


def test_area_is_missing_false_for_other_roles():
    assert area_is_missing({"logist"}, None) is False


def test_resolve_area_checks_among_multiple_roles():
    assert resolve_area({"logist", "nachalnik_uchastka"}, Area.SHCHITOVYE_DVERI) == Area.SHCHITOVYE_DVERI
