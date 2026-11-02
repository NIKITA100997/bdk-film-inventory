from datetime import datetime, timezone
from unittest.mock import MagicMock
import pytest
from starlette.testclient import TestClient

from app.core.security import get_current_user
from app.db.session import SessionLocal
from app.main import app
from app.models.units import MaterialUnit, UnitStatus
from app.models.events import MaterialEvent, EventType
from app.models.part_units import PartUnit, PartUnitStatus, PartUnitEvent, PartEventType
from app.models.dictionaries import MaterialSku, Material, Color, Thickness, Manufacturer, Part, PartStage
from app.models.users import User


def test_restore_write_off_unit():
    db = SessionLocal()
    try:
        user = db.query(User).first()
        assert user is not None

        mat = db.query(Material).first()
        col = db.query(Color).first()
        th = db.query(Thickness).first()
        mf = db.query(Manufacturer).first()
        sku = db.query(MaterialSku).filter_by(material_id=mat.id, color_id=col.id, thickness_id=th.id, manufacturer_id=mf.id).first()
        if not sku:
            sku = MaterialSku(material_id=mat.id, color_id=col.id, thickness_id=th.id, manufacturer_id=mf.id)
            db.add(sku)
            db.commit()

        unit = MaterialUnit(
            material_sku_id=sku.id,
            upd_number="TEST-UPD-RESTORE",
            pallet_number="TEST-PAL-RESTORE",
            length_m=360.0,
            width_mm=1400.0,
            status=UnitStatus.SPISAN,
            location_code="Д-01",
            is_strip=True,
        )
        db.add(unit)
        db.commit()
        db.refresh(unit)

        mock_user = MagicMock(spec=User)
        mock_user.id = user.id
        mock_user.is_superuser = True
        mock_user.permissions = ["units.writeoff", "units.correct", "reports.view"]

        app.dependency_overrides[get_current_user] = lambda: mock_user
        try:
            client = TestClient(app)
            resp = client.post(
                f"/api/units/{unit.id}/restore-write-off",
                json={"actual_length_m": 360.0, "location_code": "Д-01", "note": "Ошибочное списание штрипса 4385"},
                headers={"Authorization": "Bearer test"},
            )
            assert resp.status_code == 200, resp.text
            data = resp.json()
            assert data["status"] == "На_хранении"
            assert data["length_m"] == 360.0
            assert data["location_code"] == "Д-01"

            # Check event
            ev = db.query(MaterialEvent).filter(MaterialEvent.unit_id == unit.id).order_by(MaterialEvent.timestamp.desc()).first()
            assert ev is not None
            assert ev.event_type == EventType.KORREKTIROVKA
            assert ev.quantity_delta_m == 360.0
            assert "Ошибочное списание" in (ev.write_off_note or "")

            # Check action log endpoint returns unit_status
            log_resp = client.get(f"/api/reports/action-log/material?unit_id={unit.id}", headers={"Authorization": "Bearer test"})
            assert log_resp.status_code == 200
            log_data = log_resp.json()
            assert len(log_data) >= 1
            assert log_data[0]["unit_status"] == "На_хранении"
            assert log_data[0]["current_length_m"] == 360.0
        finally:
            app.dependency_overrides.clear()
            # Clean up test unit
            db.query(MaterialEvent).filter(MaterialEvent.unit_id == unit.id).delete()
            db.delete(unit)
            db.commit()
    finally:
        db.close()


def test_restore_write_off_part_unit():
    db = SessionLocal()
    try:
        user = db.query(User).first()
        part = db.query(Part).first()
        stage = db.query(PartStage).first()

        pu = PartUnit(
            part_id=part.id,
            stage_id=stage.id,
            quantity_pieces=50.0,
            status=PartUnitStatus.SPISAN,
            location_code="ПФ-01",
            created_by=user.id,
        )
        db.add(pu)
        db.commit()
        db.refresh(pu)

        mock_user = MagicMock(spec=User)
        mock_user.id = user.id
        mock_user.is_superuser = True
        mock_user.permissions = ["part_units.manage", "part_units.correct", "reports.view"]

        app.dependency_overrides[get_current_user] = lambda: mock_user
        try:
            client = TestClient(app)
            resp = client.post(
                f"/api/part-units/{pu.id}/restore-write-off",
                json={"actual_quantity_pieces": 50.0, "location_code": "ПФ-02", "note": "Восстановление партии"},
                headers={"Authorization": "Bearer test"},
            )
            assert resp.status_code == 200, resp.text
            data = resp.json()
            assert data["status"] == "На_хранении"
            assert data["quantity_pieces"] == 50.0
            assert data["location_code"] == "ПФ-02"

            ev = db.query(PartUnitEvent).filter(PartUnitEvent.part_unit_id == pu.id).order_by(PartUnitEvent.occurred_at.desc()).first()
            assert ev is not None
            assert ev.event_type == PartEventType.KORREKTIROVKA
            assert ev.quantity_delta == 50.0
        finally:
            app.dependency_overrides.clear()
            # Clean up test part unit
            db.query(PartUnitEvent).filter(PartUnitEvent.part_unit_id == pu.id).delete()
            db.delete(pu)
            db.commit()
    finally:
        db.close()
