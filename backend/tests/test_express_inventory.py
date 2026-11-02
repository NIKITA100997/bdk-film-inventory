from unittest.mock import MagicMock
import pytest
from starlette.testclient import TestClient

from app.core.security import get_current_user
from app.db.session import SessionLocal
from app.main import app
from app.models.dictionaries import Color, Manufacturer, Material, MaterialSku, Thickness
from app.models.part_counts import (
    COUNT_IN_PROGRESS,
    KIND_FILM,
    PLACE_WAREHOUSE,
    PartCountLine,
    PartCountSession,
)
from app.models.storage import Warehouse, Rack
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User


@pytest.fixture
def test_data():
    db = SessionLocal()
    try:
        user = db.query(User).first()
        wh = db.query(Warehouse).first()
        if not wh:
            wh = Warehouse(name="Склад Тест", is_active=True, default_cell="Д-01")
            db.add(wh)
            db.commit()

        mat = db.query(Material).first()
        col = db.query(Color).first()
        th = db.query(Thickness).first()
        man = db.query(Manufacturer).first()
        sku = db.query(MaterialSku).filter_by(material_id=mat.id, color_id=col.id, thickness_id=th.id, manufacturer_id=man.id).first()
        if not sku:
            sku = MaterialSku(material_id=mat.id, color_id=col.id, thickness_id=th.id, manufacturer_id=man.id)
            db.add(sku)
            db.commit()

        u1 = MaterialUnit(
            material_sku_id=sku.id,
            status=UnitStatus.NA_KHRANENII,
            width_mm=1250,
            length_m=350.0,
            location_code="Д-01",
            upd_number="UPD-TEST-INV-1",
            pallet_number="PAL-1",
        )
        u2 = MaterialUnit(
            material_sku_id=sku.id,
            status=UnitStatus.NA_KHRANENII,
            width_mm=1250,
            length_m=120.0,
            location_code="Д-02",
            upd_number="UPD-TEST-INV-2",
            pallet_number="PAL-2",
        )
        db.add_all([u1, u2])
        db.commit()

        sess = PartCountSession(
            place_type=PLACE_WAREHOUSE,
            place_ref=str(wh.id),
            status=COUNT_IN_PROGRESS,
            started_by=user.id,
        )
        db.add(sess)
        db.commit()

        l1 = PartCountLine(
            session_id=sess.id,
            kind=KIND_FILM,
            material_unit_id=u1.id,
            expected_qty=350.0,
        )
        l2 = PartCountLine(
            session_id=sess.id,
            kind=KIND_FILM,
            material_unit_id=u2.id,
            expected_qty=120.0,
        )
        db.add_all([l1, l2])
        db.commit()

        yield {
            "user_id": user.id,
            "sess_id": sess.id,
            "u1_id": u1.id,
            "u2_id": u2.id,
            "l1_id": l1.id,
            "l2_id": l2.id,
        }
    finally:
        db.close()


def test_scan_cell_code(test_data):
    db = SessionLocal()
    try:
        user = db.get(User, test_data["user_id"])
        mock_user = MagicMock(spec=User)
        mock_user.id = user.id
        mock_user.is_superuser = True
        mock_user.permissions = ["inventory.manage", "part_units.count", "units.receive", "materials.manage", "production_tasks.manage", "part_units.manage", "fg.ship"]

        app.dependency_overrides[get_current_user] = lambda: mock_user
        client = TestClient(app)

        res = client.post(f"/api/part-counts/{test_data['sess_id']}/scan", json={"barcode": "Д-01"})
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["action"] == "cell_selected"
        assert data["cell_code"] == "Д-01"
    finally:
        app.dependency_overrides.clear()
        db.close()


def test_scan_unit_in_matching_cell(test_data):
    db = SessionLocal()
    try:
        user = db.get(User, test_data["user_id"])
        mock_user = MagicMock(spec=User)
        mock_user.id = user.id
        mock_user.is_superuser = True
        mock_user.permissions = ["inventory.manage", "part_units.count", "units.receive", "materials.manage", "production_tasks.manage", "part_units.manage", "fg.ship"]

        app.dependency_overrides[get_current_user] = lambda: mock_user
        client = TestClient(app)

        u1_id = test_data["u1_id"]
        res = client.post(
            f"/api/part-counts/{test_data['sess_id']}/scan",
            json={"barcode": f"ПЛ-{u1_id}", "current_cell": "Д-01", "auto_confirm": True},
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["action"] == "unit_confirmed"
        assert not data["is_mismatch"]
        assert data["unit_id"] == u1_id

        line = db.get(PartCountLine, test_data["l1_id"])
        assert float(line.counted_qty) == 350.0
    finally:
        app.dependency_overrides.clear()
        db.close()


def test_scan_unit_location_mismatch(test_data):
    db = SessionLocal()
    try:
        user = db.get(User, test_data["user_id"])
        mock_user = MagicMock(spec=User)
        mock_user.id = user.id
        mock_user.is_superuser = True
        mock_user.permissions = ["inventory.manage", "part_units.count", "units.receive", "materials.manage", "production_tasks.manage", "part_units.manage", "fg.ship"]

        app.dependency_overrides[get_current_user] = lambda: mock_user
        client = TestClient(app)

        u2_id = test_data["u2_id"]
        res = client.post(
            f"/api/part-counts/{test_data['sess_id']}/scan",
            json={"barcode": f"{u2_id}", "current_cell": "Д-01", "auto_confirm": True},
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["action"] == "unit_mismatch"
        assert data["is_mismatch"]
        assert data["expected_location"] == "Д-02"
    finally:
        app.dependency_overrides.clear()
        db.close()


def test_relocate_unit(test_data):
    db = SessionLocal()
    try:
        user = db.get(User, test_data["user_id"])
        mock_user = MagicMock(spec=User)
        mock_user.id = user.id
        mock_user.is_superuser = True
        mock_user.permissions = ["inventory.manage", "part_units.count", "units.receive", "materials.manage", "production_tasks.manage", "part_units.manage", "fg.ship"]

        app.dependency_overrides[get_current_user] = lambda: mock_user
        client = TestClient(app)

        l2_id = test_data["l2_id"]
        u2_id = test_data["u2_id"]
        res = client.post(
            f"/api/part-counts/{test_data['sess_id']}/lines/{l2_id}/relocate",
            json={"new_location_code": "Д-01"},
        )
        assert res.status_code == 200, res.text

        unit = db.get(MaterialUnit, u2_id)
        assert unit.location_code == "Д-01"
    finally:
        app.dependency_overrides.clear()
        db.close()


def test_confirm_cell(test_data):
    db = SessionLocal()
    try:
        user = db.get(User, test_data["user_id"])
        mock_user = MagicMock(spec=User)
        mock_user.id = user.id
        mock_user.is_superuser = True
        mock_user.permissions = ["inventory.manage", "part_units.count", "units.receive", "materials.manage", "production_tasks.manage", "part_units.manage", "fg.ship"]

        app.dependency_overrides[get_current_user] = lambda: mock_user
        client = TestClient(app)

        res = client.post(
            f"/api/part-counts/{test_data['sess_id']}/confirm-cell",
            json={"cell_code": "Д-01"},
        )
        assert res.status_code == 200, res.text

        line1 = db.get(PartCountLine, test_data["l1_id"])
        assert float(line1.counted_qty) == 350.0
    finally:
        app.dependency_overrides.clear()
        db.close()
