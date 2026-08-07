from app.services.inventory import ScanMatchKind, match_scan, resolve_participant_ids


def test_confirms_when_location_matches():
    result = match_scan("Р-3-07", "Р-3-07")
    assert result.kind == ScanMatchKind.CONFIRMED


def test_moved_when_location_differs():
    result = match_scan("Ш-2-04-06", "Ш-2-07-04")
    assert result.kind == ScanMatchKind.MOVED
    assert result.from_cell == "Ш-2-04-06"
    assert result.to_cell == "Ш-2-07-04"


def test_moved_when_no_prior_location():
    """Единица существовала в системе, но без адреса (например, не была
    ещё размещена) — любой физический адрес при скане считается перемещением."""
    result = match_scan(None, "Р-3-07")
    assert result.kind == ScanMatchKind.MOVED


def test_participants_includes_starter_first():
    assert resolve_participant_ids(started_by=1, requested_participant_ids=[2, 3]) == [1, 2, 3]


def test_participants_dedupes_starter_if_self_included():
    assert resolve_participant_ids(started_by=1, requested_participant_ids=[1, 2]) == [1, 2]


def test_participants_dedupes_repeats():
    assert resolve_participant_ids(started_by=1, requested_participant_ids=[2, 2, 3, 3]) == [1, 2, 3]


def test_participants_empty_requested_leaves_only_starter():
    assert resolve_participant_ids(started_by=5, requested_participant_ids=[]) == [5]
