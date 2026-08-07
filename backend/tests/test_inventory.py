from app.services.inventory import ScanMatchKind, match_scan


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
