from datetime import datetime, timezone
from unittest.mock import MagicMock
import pytest
from starlette.testclient import TestClient

from app.api.production import _task_out
from app.core.security import get_current_user
from app.db.session import SessionLocal
from app.main import app
from app.models.areas import Area
from app.models.dictionaries import Color, Material
from app.models.production import ProductionLine, ProductionTask, ProductionTaskLine
from app.models.production_orders import ProductionOrder
from app.models.users import User
from app.schemas.production import JobCardOut
from app.services.job_card import build_job_card


def test_build_job_card_service_calculations():
    db = SessionLocal()
    try:
        area = db.query(Area).first()
        assert area is not None

        user = db.query(User).first()
        assert user is not None

        order = ProductionOrder(
            name="Заказ покупателя № 777",
            note="Срочно до пятницы, упаковка в термоусадку",
            created_by=user.id,
        )
        db.add(order)
        db.commit()

        task = ProductionTask(
            name="Задание № 100 на окутку",
            area=area.code,
            production_order_id=order.id,
            external_order_ref=777,
            created_by=user.id,
            created_at=datetime.now(timezone.utc),
        )
        db.add(task)
        db.commit()

        line1 = ProductionTaskLine(
            task_id=task.id,
            part_name="Стоевая 2150",
            quantity_pieces=20.0,
            width_mm=120.0,
            length_m=2.15,
            strip_width_mm=160.0,
            program="PRG_2150",
            instruction="Зазор 0.2мм",
        )
        line2 = ProductionTaskLine(
            task_id=task.id,
            part_name="Поперечина 800",
            quantity_pieces=30.0,
            width_mm=80.0,
            length_m=0.8,
            strip_width_mm=120.0,
            program="PRG_800",
            instruction=None,
        )
        db.add_all([line1, line2])
        db.commit()

        task_out = _task_out(db, task)
        card = build_job_card(db, task, task_out)

        assert card.task_id == task.id
        assert card.area_code == area.code
        assert card.order_name == "Заказ покупателя № 777"
        assert card.order_note == "Срочно до пятницы, упаковка в термоусадку"
        assert card.total_quantity == 50.0
        assert card.qr_code_value == f"TASK:{task.id}"

        # Check lines
        assert len(card.lines) == 2
        l1 = [l for l in card.lines if l.part_name == "Стоевая 2150"][0]
        assert l1.dimensions == "2150 x 120 мм"
        assert l1.program == "PRG_2150"
        assert l1.instruction == "Зазор 0.2мм"
        assert l1.quantity_pieces == 20.0

        # Check materials
        assert len(card.materials) >= 1
        m1 = [m for m in card.materials if m.strip_width_mm == 160.0][0]
        # Planned meters for line 1: 20 * 2.15 * 1.05 = 45.15
        assert m1.planned_meters == 45.15
    finally:
        db.close()


def test_job_card_api_endpoint():
    db = SessionLocal()
    try:
        area = db.query(Area).first()
        assert area is not None

        user = db.query(User).filter(User.username == "admin").first()
        if not user:
            user = db.query(User).first()
        assert user is not None

        task = ProductionTask(
            name="Тестовое задание для JobCard API",
            area=area.code,
            created_by=user.id,
            created_at=datetime.now(timezone.utc),
        )
        db.add(task)
        db.commit()

        line = ProductionTaskLine(
            task_id=task.id,
            part_name="Стоевая глухая 2000",
            quantity_pieces=15.0,
            width_mm=100.0,
            length_m=2.0,
            strip_width_mm=140.0,
        )
        db.add(line)
        db.commit()

        mock_user = MagicMock(spec=User)
        mock_user.id = user.id
        mock_user.is_superuser = True
        mock_user.area = None
        mock_user.permissions = ["production.view", "tasks.view"]

        app.dependency_overrides[get_current_user] = lambda: mock_user
        try:
            client = TestClient(app)
            res = client.get(f"/api/production-tasks/{task.id}/job-card", headers={"Authorization": "Bearer test"})
            assert res.status_code == 200, res.text
            data = res.json()
            assert data["task_id"] == task.id
            assert data["area_code"] == area.code
            assert data["qr_code_value"] == f"TASK:{task.id}"
            assert len(data["lines"]) == 1
            assert data["lines"][0]["part_name"] == "Стоевая глухая 2000"
            assert data["lines"][0]["dimensions"] == "2000 x 100 мм"
        finally:
            app.dependency_overrides.clear()
    finally:
        db.close()
