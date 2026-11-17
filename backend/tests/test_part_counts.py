from unittest.mock import MagicMock
from starlette.testclient import TestClient

from app.core.security import get_current_user
from app.db.session import SessionLocal
from app.main import app
from app.models.areas import Area
from app.models.dictionaries import Part, PartStage
from app.models.part_counts import (
    COUNT_IN_PROGRESS,
    DECISION_ACCEPT,
    DECISION_KEEP,
    DECISION_WRITE_OFF,
    KIND_PF,
    PLACE_AREA,
    PartCountLine,
    PartCountSession,
)
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.users import User
from app.services.part_counts import allowed_decisions, diff_of


def test_diff_not_counted():
    assert diff_of(10, None) is None
    assert allowed_decisions(10, None) == []


def test_diff_matches():
    assert diff_of(10, 10) == 0
    assert allowed_decisions(10, 10) == []


def test_shortage_write_off_or_keep():
    assert diff_of(10, 7) == -3
    assert allowed_decisions(10, 7) == [DECISION_WRITE_OFF, DECISION_KEEP]


def test_surplus_accept_or_keep():
    assert diff_of(0, 5) == 5
    assert allowed_decisions(0, 5) == [DECISION_ACCEPT, DECISION_KEEP]


def test_part_group_count_flow():
    db = SessionLocal()
    try:
        user = db.query(User).first()
        area = db.query(Area).first()
        if not area:
            area = Area(code="TEST_AREA", name="Тестовый участок", is_active=True)
            db.add(area)
            db.commit()

        part = db.query(Part).first()
        if not part:
            part = Part(name="Тестовая деталь 2000x100", width_mm=100, length_m=2.0)
            db.add(part)
            db.commit()

        stage = db.query(PartStage).filter_by(part_id=part.id).first()
        if not stage:
            stage = PartStage(part_id=part.id, name="Тестовый этап", sequence_order=1, area=area.code)
            db.add(stage)
            db.commit()

        pu1 = PartUnit(part_id=part.id, stage_id=stage.id, area=area.code, quantity_pieces=30, status=PartUnitStatus.VYDAN_UCHASTKU, created_by=user.id)
        pu2 = PartUnit(part_id=part.id, stage_id=stage.id, area=area.code, quantity_pieces=20, status=PartUnitStatus.VYDAN_UCHASTKU, created_by=user.id)
        db.add_all([pu1, pu2])
        db.commit()

        sess = PartCountSession(
            place_type=PLACE_AREA,
            place_ref=area.code,
            area=area.code,
            status=COUNT_IN_PROGRESS,
            started_by=user.id,
            scope={"kinds": [KIND_PF]},
        )
        db.add(sess)
        db.commit()

        l1 = PartCountLine(session_id=sess.id, kind=KIND_PF, part_id=part.id, stage_id=stage.id, part_unit_id=pu1.id, expected_qty=30)
        l2 = PartCountLine(session_id=sess.id, kind=KIND_PF, part_id=part.id, stage_id=stage.id, part_unit_id=pu2.id, expected_qty=20)
        db.add_all([l1, l2])
        db.commit()

        mock_user = MagicMock(spec=User)
        mock_user.id = user.id
        mock_user.is_superuser = True
        app.dependency_overrides[get_current_user] = lambda: mock_user
        client = TestClient(app)

        # 1. Setting exact matching count (50)
        res = client.put(f"/api/part-counts/{sess.id}/parts/count", json={"part_id": part.id, "stage_id": stage.id, "counted_qty": 50})
        assert res.status_code == 200, res.text
        db.expire_all()
        assert float(db.get(PartCountLine, l1.id).counted_qty) == 30.0
        assert float(db.get(PartCountLine, l2.id).counted_qty) == 20.0

        # 2. Setting shortage count (40 instead of 50)
        res = client.put(f"/api/part-counts/{sess.id}/parts/count", json={"part_id": part.id, "stage_id": stage.id, "counted_qty": 40})
        assert res.status_code == 200, res.text
        db.expire_all()
        q1 = float(db.get(PartCountLine, l1.id).counted_qty)
        q2 = float(db.get(PartCountLine, l2.id).counted_qty)
        assert q1 + q2 == 40.0

        # 3. Setting surplus count (55 instead of 50)
        res = client.put(f"/api/part-counts/{sess.id}/parts/count", json={"part_id": part.id, "stage_id": stage.id, "counted_qty": 55})
        assert res.status_code == 200, res.text
        db.expire_all()
        q1 = float(db.get(PartCountLine, l1.id).counted_qty)
        q2 = float(db.get(PartCountLine, l2.id).counted_qty)
        assert q1 + q2 == 55.0

        # 4. Resetting count (null)
        res = client.put(f"/api/part-counts/{sess.id}/parts/count", json={"part_id": part.id, "stage_id": stage.id, "counted_qty": None})
        assert res.status_code == 200, res.text
        db.expire_all()
        assert db.get(PartCountLine, l1.id).counted_qty is None
        assert db.get(PartCountLine, l2.id).counted_qty is None
    finally:
        app.dependency_overrides.clear()
        db.close()

