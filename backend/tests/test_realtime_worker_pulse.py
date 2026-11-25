"""Tests for SSE realtime broker, background task_worker/jobs API, and 3-day predictive pulse."""

import time
from starlette.testclient import TestClient

from app.core.security import get_current_user
from app.db.session import SessionLocal
from app.main import app
from app.models.users import User
from app.services.factory_pulse import compute_factory_pulse
from app.services.predictive_pulse import compute_predictive_risks
from app.services.realtime import publish_event
from app.services.task_worker import submit_job


def test_realtime_stream_requires_auth_and_publish_safe():
    client = TestClient(app)
    r = client.get("/api/realtime/stream")
    assert r.status_code == 401
    # Safe when no subscribers
    publish_event("units", {"unit_id": 123})


def test_background_worker_and_jobs_endpoints():
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.is_active.is_(True)).first()
        assert user is not None
        app.dependency_overrides[get_current_user] = lambda: user
        client = TestClient(app)

        job_id = submit_job(
            "test-pdf",
            lambda: b"%PDF-1.4-TEST",
            content_type="application/pdf",
            filename="test.pdf",
        )
        status_data = None
        for _ in range(20):
            r = client.get(f"/api/jobs/{job_id}")
            assert r.status_code == 200
            status_data = r.json()
            if status_data["status"] == "done":
                break
            time.sleep(0.05)

        assert status_data is not None
        assert status_data["status"] == "done"
        assert status_data["has_download"] is True

        dl = client.get(f"/api/jobs/{job_id}/download")
        assert dl.status_code == 200
        assert dl.content == b"%PDF-1.4-TEST"
        assert dl.headers["content-type"] == "application/pdf"
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        db.close()


def test_predictive_pulse_returns_risks():
    db = SessionLocal()
    try:
        risks = compute_predictive_risks(db, horizon_days=3)
        assert isinstance(risks, list)
        assert len(risks) >= 1
        for item in risks:
            assert item["level"] in {"danger", "warning", "info", "success"}
            assert item["title"]
            assert item["text"]

        pulse = compute_factory_pulse(db)
        d = pulse.to_dict()
        assert "predictive_risks" in d
        assert isinstance(d["predictive_risks"], list)
    finally:
        db.close()
