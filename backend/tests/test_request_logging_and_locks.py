"""Tests for centralized request_id logging middleware and for_update locking helpers."""

from starlette.testclient import TestClient

from app.api.part_units import _get_part_unit
from app.api.units import _get_storable_unit
from app.db.session import SessionLocal
from app.main import app
from app.models.part_units import PartUnit
from app.models.units import MaterialUnit


def test_request_id_header_generated_and_echoed():
    client = TestClient(app)
    r1 = client.get("/health")
    assert r1.status_code == 200
    assert r1.headers.get("X-Request-ID")

    r2 = client.get("/health", headers={"X-Request-ID": "custom-req-42"})
    assert r2.status_code == 200
    assert r2.headers.get("X-Request-ID") == "custom-req-42"


def test_for_update_helpers_load_existing_rows():
    db = SessionLocal()
    try:
        u = db.query(MaterialUnit).first()
        if u is not None:
            locked = _get_storable_unit(db, u.id, for_update=True)
            assert locked.id == u.id
            unlocked = _get_storable_unit(db, u.id, for_update=False)
            assert unlocked.id == u.id

        pu = db.query(PartUnit).first()
        if pu is not None:
            locked_pu = _get_part_unit(db, pu.id, for_update=True)
            assert locked_pu.id == pu.id
            unlocked_pu = _get_part_unit(db, pu.id, for_update=False)
            assert unlocked_pu.id == pu.id
    finally:
        db.rollback()
        db.close()
