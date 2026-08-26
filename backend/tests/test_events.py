from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.models.events import EventType
from app.models.units import MaterialUnit, UnitStatus
from app.schemas.units import CutRequest
from app.services.events import record_event


class FakeSession:
    """Заглушка вместо реальной БД (раздел про дату операции задним
    числом) — record_event() только конструирует MaterialEvent и делает
    db.add(...), commit не нужен, чтобы проверить какие поля выставились."""

    def add(self, obj):
        pass


def make_unit(**overrides) -> MaterialUnit:
    defaults = dict(
        id=1,
        parent_id=None,
        upd_number="UPD-1",
        pallet_number="1",
        material_sku_id=42,
        width_mm=1400,
        length_m=500,
        status=UnitStatus.NA_KHRANENII,
        area=None,
        location_code="Р-3-07",
    )
    defaults.update(overrides)
    return MaterialUnit(**defaults)


class TestRecordEventOccurredAt:
    def test_without_occurred_at_leaves_timestamp_unset(self):
        """Без occurred_at — timestamp не передаётся конструктору вообще,
        сработает server_default=func.now() на самой колонке (как раньше)."""
        unit = make_unit()
        event = record_event(FakeSession(), unit=unit, event_type=EventType.RASKROY, user_id=1)
        assert "timestamp" not in event.__dict__ or event.timestamp is None

    def test_with_occurred_at_uses_given_timestamp(self):
        unit = make_unit()
        backdated = datetime(2026, 8, 23, 12, 0, 0, tzinfo=timezone.utc)
        event = record_event(
            FakeSession(), unit=unit, event_type=EventType.RASKROY, user_id=1, occurred_at=backdated
        )
        assert event.timestamp == backdated


class TestOccurredAtValidation:
    def test_rejects_future_date(self):
        future = datetime.now(timezone.utc) + timedelta(days=1)
        with pytest.raises(ValidationError):
            CutRequest(cut_length_m=1, occurred_at=future)

    def test_accepts_past_date(self):
        past = datetime.now(timezone.utc) - timedelta(days=1)
        req = CutRequest(cut_length_m=1, occurred_at=past)
        assert req.occurred_at == past

    def test_accepts_none(self):
        req = CutRequest(cut_length_m=1)
        assert req.occurred_at is None
