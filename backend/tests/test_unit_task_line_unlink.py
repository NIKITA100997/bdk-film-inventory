"""Tests for unlinking task line, clearing task line on return/batch-issue,
and filtering historical reports in reconciliation.
"""
from datetime import datetime, timezone, timedelta
from starlette.testclient import TestClient

from app.main import app
from app.core.security import get_current_user
from app.db.session import SessionLocal
from app.models.areas import Area
from app.models.dictionaries import MaterialSku
from app.services.events import record_event
from app.models.events import EventType, MaterialEvent
from app.models.production import (
    ProductionTask,
    ProductionTaskLine,
    ProductionTaskLineReport,
)
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User


def _cleanup(db, task_id=None, unit_id=None):
    try:
        if unit_id:
            db.query(MaterialEvent).filter(MaterialEvent.unit_id == unit_id).delete(synchronize_session=False)
            db.query(ProductionTaskLineReport).filter(ProductionTaskLineReport.material_unit_id == unit_id).delete(synchronize_session=False)
            db.query(MaterialUnit).filter(MaterialUnit.id == unit_id).delete(synchronize_session=False)
        if task_id:
            line_ids = [l.id for l in db.query(ProductionTaskLine.id).filter(ProductionTaskLine.task_id == task_id).all()]
            if line_ids:
                db.query(ProductionTaskLineReport).filter(ProductionTaskLineReport.task_line_id.in_(line_ids)).delete(synchronize_session=False)
            db.query(ProductionTaskLine).filter(ProductionTaskLine.task_id == task_id).delete(synchronize_session=False)
            db.query(ProductionTask).filter(ProductionTask.id == task_id).delete(synchronize_session=False)
        db.commit()
    except Exception:
        db.rollback()


def test_unlink_task_line_api():
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.is_superuser.is_(True)).first()
        if not user:
            user = db.query(User).first()
            user.is_superuser = True
            db.commit()

        app.dependency_overrides[get_current_user] = lambda: user
        client = TestClient(app)

        sku = db.query(MaterialSku).first()
        task = ProductionTask(name="Test Task Unlink", area="okutka_tsargovykh", created_by=user.id)
        db.add(task)
        db.flush()

        line = ProductionTaskLine(
            task_id=task.id,
            material_id=sku.material_id,
            color_id=sku.color_id,
            thickness_id=sku.thickness_id,
            width_mm=100.0,
            length_m=2000.0,
            quantity_pieces=10,
        )
        db.add(line)
        db.flush()

        unit = MaterialUnit(
            upd_number="TEST-UPD-1",
            pallet_number="PAL-1",
            material_sku_id=sku.id,
            width_mm=100.0,
            length_m=500.0,
            status=UnitStatus.VYDAN_UCHASTKU,
            area="okutka_tsargovykh",
            production_task_line_id=line.id,
        )
        db.add(unit)
        db.commit()

        # Unlink by sending production_task_line_id: None
        resp = client.patch(f"/api/units/{unit.id}/task-line", json={"production_task_line_id": None})
        assert resp.status_code == 200, f"Failed to unlink: {resp.text}"
        data = resp.json()
        assert data["production_task_line_id"] is None

        db.refresh(unit)
        assert unit.production_task_line_id is None
    finally:
        _cleanup(db, task_id=task.id if 'task' in locals() else None, unit_id=unit.id if 'unit' in locals() else None)
        app.dependency_overrides.pop(get_current_user, None)
        db.close()


def test_return_unit_clears_task_line():
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.is_superuser.is_(True)).first()
        app.dependency_overrides[get_current_user] = lambda: user
        client = TestClient(app)

        sku = db.query(MaterialSku).first()
        task = ProductionTask(name="Test Task Return", area="okutka_tsargovykh", created_by=user.id)
        db.add(task)
        db.flush()

        line = ProductionTaskLine(
            task_id=task.id,
            material_id=sku.material_id,
            color_id=sku.color_id,
            thickness_id=sku.thickness_id,
            width_mm=100.0,
            length_m=2000.0,
            quantity_pieces=10,
        )
        db.add(line)
        db.flush()

        unit = MaterialUnit(
            upd_number="TEST-UPD-1",
            pallet_number="PAL-1",
            material_sku_id=sku.id,
            width_mm=100.0,
            length_m=500.0,
            status=UnitStatus.VYDAN_UCHASTKU,
            area="okutka_tsargovykh",
            production_task_line_id=line.id,
        )
        db.add(unit)
        db.flush()

        # Add an issue event so return logic sees unit_issued_since
        record_event(
            db,
            unit=unit,
            event_type=EventType.VYDACHA_UCHASTKU,
            user_id=user.id,
            occurred_at=datetime.now(timezone.utc) - timedelta(hours=1),
        )
        # Add report so requires_roll_on_report passes
        rep = ProductionTaskLineReport(
            task_line_id=line.id,
            material_unit_id=unit.id,
            good_pieces=5,
            defect_pieces=0,
            reported_by=user.id,
            reported_at=datetime.now(timezone.utc) - timedelta(minutes=30),
        )
        db.add(rep)
        db.commit()

        resp = client.post(f"/api/units/{unit.id}/return", json={"actual_length_m": 450.0})
        assert resp.status_code == 200, f"Return failed: {resp.text}"
        data = resp.json()
        assert data["status"] == UnitStatus.NA_KHRANENII.value
        assert data["production_task_line_id"] is None

        db.refresh(unit)
        assert unit.status == UnitStatus.NA_KHRANENII
        assert unit.production_task_line_id is None
    finally:
        _cleanup(db, task_id=task.id if 'task' in locals() else None, unit_id=unit.id if 'unit' in locals() else None)
        app.dependency_overrides.pop(get_current_user, None)
        db.close()


def test_batch_issue_clears_stale_task_line():
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.is_superuser.is_(True)).first()
        app.dependency_overrides[get_current_user] = lambda: user
        client = TestClient(app)

        sku = db.query(MaterialSku).first()
        task = ProductionTask(name="Test Task Batch Issue", area="okutka_tsargovykh", created_by=user.id)
        db.add(task)
        db.flush()

        line = ProductionTaskLine(
            task_id=task.id,
            material_id=sku.material_id,
            color_id=sku.color_id,
            thickness_id=sku.thickness_id,
            width_mm=100.0,
            length_m=2000.0,
            quantity_pieces=10,
        )
        db.add(line)
        db.flush()

        # Stale unit on storage that had line_id set
        unit = MaterialUnit(
            upd_number="TEST-UPD-1",
            pallet_number="PAL-1",
            material_sku_id=sku.id,
            width_mm=100.0,
            length_m=500.0,
            status=UnitStatus.NA_KHRANENII,
            location_code="С-01",
            production_task_line_id=line.id,
        )
        db.add(unit)
        db.commit()

        resp = client.post("/api/units/batch-issue-to-area", json={
            "unit_ids": [unit.id],
            "area": "okutka_tsargovykh",
        })
        assert resp.status_code == 200, f"Batch issue failed: {resp.text}"
        data = resp.json()
        assert data["ok"] is True

        db.refresh(unit)
        assert unit.status == UnitStatus.VYDAN_UCHASTKU
        assert unit.production_task_line_id is None
    finally:
        _cleanup(db, task_id=task.id if 'task' in locals() else None, unit_id=unit.id if 'unit' in locals() else None)
        app.dependency_overrides.pop(get_current_user, None)
        db.close()


def test_reconciliation_filters_old_issue_reports():
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.is_superuser.is_(True)).first()
        app.dependency_overrides[get_current_user] = lambda: user
        client = TestClient(app)

        sku = db.query(MaterialSku).first()
        task = ProductionTask(name="Test Task Recon", area="okutka_tsargovykh", created_by=user.id)
        db.add(task)
        db.flush()

        line = ProductionTaskLine(
            task_id=task.id,
            material_id=sku.material_id,
            color_id=sku.color_id,
            thickness_id=sku.thickness_id,
            width_mm=100.0,
            length_m=2000.0,
            quantity_pieces=10,
        )
        db.add(line)
        db.flush()

        # Unit currently issued to area, linked to line
        unit = MaterialUnit(
            upd_number="TEST-UPD-1",
            pallet_number="PAL-1",
            material_sku_id=sku.id,
            width_mm=100.0,
            length_m=300.0,
            status=UnitStatus.VYDAN_UCHASTKU,
            area="okutka_tsargovykh",
            production_task_line_id=line.id,
        )
        db.add(unit)
        db.flush()

        now = datetime.now(timezone.utc)
        # Event 1: past issue 3 days ago
        record_event(
            db,
            unit=unit,
            event_type=EventType.VYDACHA_UCHASTKU,
            user_id=user.id,
            occurred_at=now - timedelta(days=3),
        )
        # Old report 3 days ago
        rep_old = ProductionTaskLineReport(
            task_line_id=line.id,
            material_unit_id=unit.id,
            good_pieces=50,
            defect_pieces=2,
            reported_by=user.id,
            reported_at=now - timedelta(days=3),
        )
        db.add(rep_old)
        # Event 2: recent issue 10 minutes ago (no reports yet for this stay!)
        record_event(
            db,
            unit=unit,
            event_type=EventType.VYDACHA_UCHASTKU,
            user_id=user.id,
            occurred_at=now - timedelta(minutes=10),
        )
        db.commit()
        db.commit()

        # Query reconciliation for this unit
        resp = client.get(f"/api/units/reconciliation?unit_id={unit.id}")
        assert resp.status_code == 200, f"Reconciliation failed: {resp.text}"
        rows = resp.json()
        assert len(rows) == 1
        row = rows[0]
        # Reports from past issue must be ignored:
        assert row["reports_count"] == 0
        assert row["good_pieces_sum"] == 0.0
        assert row["defect_pieces_sum"] == 0.0

        # Now add a report after ev2
        rep_new = ProductionTaskLineReport(
            task_line_id=line.id,
            material_unit_id=unit.id,
            good_pieces=15,
            defect_pieces=1,
            reported_by=user.id,
            reported_at=now - timedelta(minutes=5),
        )
        db.add(rep_new)
        db.commit()

        resp2 = client.get(f"/api/units/reconciliation?unit_id={unit.id}")
        assert resp2.status_code == 200
        row2 = resp2.json()[0]
        assert row2["reports_count"] == 1
        assert row2["good_pieces_sum"] == 15.0
        assert row2["defect_pieces_sum"] == 1.0
    finally:
        _cleanup(db, task_id=task.id if 'task' in locals() else None, unit_id=unit.id if 'unit' in locals() else None)
        app.dependency_overrides.pop(get_current_user, None)
        db.close()
