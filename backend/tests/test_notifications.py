from app.services.notifications import OpenNotification, reconcile_stale_unit_notifications


def test_new_signal_inserted():
    result = reconcile_stale_unit_notifications([], {1, 2})
    assert set(result.to_insert) == {1, 2}
    assert result.to_resolve == []


def test_disappeared_signal_resolved():
    existing = [OpenNotification(id=100, entity_id=1)]
    result = reconcile_stale_unit_notifications(existing, set())
    assert result.to_insert == []
    assert result.to_resolve == [100]


def test_unchanged_signal_neither_inserted_nor_resolved():
    existing = [OpenNotification(id=100, entity_id=1)]
    result = reconcile_stale_unit_notifications(existing, {1})
    assert result.to_insert == []
    assert result.to_resolve == []


def test_mixed_new_unchanged_and_resolved():
    existing = [OpenNotification(id=100, entity_id=1), OpenNotification(id=101, entity_id=2)]
    result = reconcile_stale_unit_notifications(existing, {1, 3})
    assert result.to_insert == [3]
    assert result.to_resolve == [101]


def test_empty_everything():
    result = reconcile_stale_unit_notifications([], set())
    assert result.to_insert == []
    assert result.to_resolve == []
