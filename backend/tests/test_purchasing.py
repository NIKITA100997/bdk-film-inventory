from app.services.purchasing import OpenRequestGroup, requests_closed_by_receipt


def test_matching_group_closed():
    open_requests = [OpenRequestGroup(1, material_id=10, color_id=20, thickness_id=30)]
    closed = requests_closed_by_receipt(open_requests, material_id=10, color_id=20, thickness_id=30)
    assert closed == [1]


def test_non_matching_group_left_open():
    open_requests = [OpenRequestGroup(1, material_id=10, color_id=20, thickness_id=30)]
    closed = requests_closed_by_receipt(open_requests, material_id=10, color_id=20, thickness_id=99)
    assert closed == []


def test_multiple_matches_all_closed():
    open_requests = [
        OpenRequestGroup(1, material_id=10, color_id=20, thickness_id=30),
        OpenRequestGroup(2, material_id=10, color_id=20, thickness_id=30),
        OpenRequestGroup(3, material_id=99, color_id=20, thickness_id=30),
    ]
    closed = requests_closed_by_receipt(open_requests, material_id=10, color_id=20, thickness_id=30)
    assert closed == [1, 2]


def test_empty_open_requests():
    assert requests_closed_by_receipt([], material_id=10, color_id=20, thickness_id=30) == []
