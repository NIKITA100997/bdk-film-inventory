"""Tests for Production Monitor API."""
from starlette.testclient import TestClient

from app.main import app
from app.core.security import get_current_user
from app.db.session import SessionLocal
from app.models.users import User


def test_production_monitor_endpoint():
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.is_active.is_(True), User.is_superuser.is_(True)).first()
        if not user:
            user = db.query(User).filter(User.is_active.is_(True)).first()
        assert user is not None

        app.dependency_overrides[get_current_user] = lambda: user
        client = TestClient(app)

        r = client.get("/api/production-monitor")
        assert r.status_code == 200, f"GET /api/production-monitor failed: {r.text}"
        data = r.json()
        assert "areas" in data
        assert "orders" in data
        assert "rows" in data
        assert isinstance(data["rows"], list)

        r_done = client.get("/api/production-monitor?include_done=true")
        assert r_done.status_code == 200
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        db.close()
