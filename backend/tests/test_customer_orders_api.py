"""Tests for Customer Orders API."""
from starlette.testclient import TestClient

from app.main import app
from app.core.security import get_current_user
from app.db.session import SessionLocal
from app.models.customer_orders import CustomerOrder, CO_DRAFT
from app.models.users import User


def test_list_customer_orders():
    db = SessionLocal()
    try:
        # Get an active user
        user = db.query(User).filter(User.is_active.is_(True)).first()
        assert user is not None

        # Override auth dependency
        app.dependency_overrides[get_current_user] = lambda: user

        client = TestClient(app)

        # Test include_closed=False (default)
        r = client.get("/api/customer-orders")
        assert r.status_code == 200, f"GET /api/customer-orders failed: {r.text}"
        assert isinstance(r.json(), list)

        # Test include_closed=True
        r_all = client.get("/api/customer-orders?include_closed=true")
        assert r_all.status_code == 200, f"GET /api/customer-orders?include_closed=true failed: {r_all.text}"
        assert isinstance(r_all.json(), list)
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        db.close()
