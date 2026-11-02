"""Тесты для Phase 4:
1. Волновой маршрутный лист сборки (Pick Route): упорядочивание ячеек по пути обхода склада.
2. Контроль сканирования QR-кода при снятии рулона (защита от пересортицы).
3. Универсальный аудит изменений (Audit Trail).
4. Dead Letter Queue (DLQ) и повтор внешних событий.
"""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.models.audit import DeadLetterEvent, EntityAuditLog
from app.models.dictionaries import Color, Material, MaterialSku, Thickness
from app.models.production import ProductionTask, ProductionTaskLine
from app.models.units import MaterialUnit, UnitStatus
from app.services.async_queue import enqueue_dead_letter, retry_dead_letter
from app.services.audit import get_audit_history, record_audit
from app.services.pick_route import (
    _parse_location_key,
    generate_pick_route,
    verify_pick_scanned_barcode,
)


def test_location_natural_sorting():
    """Проверка естественной сортировки ячеек склада (Стеллаж -> Полка)."""
    locations = ["Ш-2-04", "Р-3-12", "Р-1-02", "Р-1-10", "Р-3-01", "Перемотка-01"]
    sorted_locs = sorted(locations, key=_parse_location_key)

    # Р-1 (2, 10), then Р-3 (1, 12), then Ш-2, then unplaced/other
    assert sorted_locs[0] == "Р-1-02"
    assert sorted_locs[1] == "Р-1-10"
    assert sorted_locs[2] == "Р-3-01"
    assert sorted_locs[3] == "Р-3-12"
    assert sorted_locs[4] == "Ш-2-04"


def test_verify_pick_scanned_barcode_success_and_mismatch():
    """Проверка верификации сканирования рулона: совпадение и предотвращение пересортицы."""
    db = MagicMock()

    # Matching line
    line = ProductionTaskLine(
        id=50,
        task_id=1,
        material_id=10,
        color_id=20,
        thickness_id=30,
        width_mm=250.0,
        length_m=2.0,
    )
    db.get.side_effect = lambda model, pk: line if model == ProductionTaskLine and pk == 50 else None

    # Correct unit
    sku_correct = MaterialSku(id=1, material_id=10, color_id=20, thickness_id=30)
    unit_correct = MaterialUnit(
        id=777,
        material_sku=sku_correct,
        width_mm=250.0,
        length_m=100.0,
        location_code="Р-2-05",
    )

    # Wrong unit (wrong color)
    sku_wrong = MaterialSku(id=2, material_id=10, color_id=99, thickness_id=30)
    unit_wrong = MaterialUnit(
        id=888,
        material_sku=sku_wrong,
        width_mm=250.0,
        length_m=100.0,
        location_code="Р-2-06",
    )

    # 1. Success check
    with patch.object(db, "get", side_effect=lambda model, pk: unit_correct if model == MaterialUnit and pk == 777 else (line if model == ProductionTaskLine and pk == 50 else None)):
        res_ok = verify_pick_scanned_barcode(db, scanned_barcode="777", expected_task_line_id=50)
        assert res_ok["verified"] is True
        assert res_ok["unit_id"] == 777

    # 2. Mismatch check (different decor)
    with patch.object(db, "get", side_effect=lambda model, pk: unit_wrong if model == MaterialUnit and pk == 888 else (line if model == ProductionTaskLine and pk == 50 else None)):
        res_fail = verify_pick_scanned_barcode(db, scanned_barcode="888", expected_task_line_id=50)
        assert res_fail["verified"] is False
        assert "ОШИБКА ПЕРЕСОРТИЦЫ" in res_fail["error"]


def test_audit_trail_logging_and_history():
    """Проверка записи и чтения журнала аудита сущностей."""
    db = MagicMock()
    mock_log = EntityAuditLog(
        id=1,
        entity_type="CustomerOrder",
        entity_id=42,
        action="STATUS_CHANGE",
        changed_fields={"status": {"old": "draft", "new": "accepted"}},
        user_id=1,
        user_name="Иванов И.И.",
        created_at=datetime.now(timezone.utc),
    )

    # Record
    entry = record_audit(
        db,
        entity_type="CustomerOrder",
        entity_id=42,
        action="STATUS_CHANGE",
        changed_fields={"status": {"old": "draft", "new": "accepted"}},
        user_id=1,
        user_name="Иванов И.И.",
    )
    assert db.add.called
    assert entry.entity_type == "CustomerOrder"
    assert entry.entity_id == 42

    # Query history
    db.query(EntityAuditLog).filter().order_by().limit().all.return_value = [mock_log]
    history = get_audit_history(db, entity_type="CustomerOrder", entity_id=42)
    assert len(history) == 1
    assert history[0]["entity_id"] == 42
    assert history[0]["action"] == "STATUS_CHANGE"


def test_dead_letter_queue_and_retry():
    """Проверка помещения в DLQ и ручного повтора события."""
    db = MagicMock()
    dlq_event = DeadLetterEvent(
        id=10,
        service="bitrix24",
        event_type="sync_deal",
        payload={"order_id": 42, "target_stage": "IN_PRODUCTION"},
        attempts=1,
        status="dead_letter",
    )
    db.get.return_value = dlq_event

    with patch("app.services.bitrix_deals.sync_order_deals") as mock_sync:
        res = retry_dead_letter(db, event_id=10)
        assert res["success"] is True
        assert res["status"] == "delivered"
        assert dlq_event.status == "delivered"
        assert mock_sync.called


def test_pick_route_endpoint_not_captured_by_unit_id():
    """Проверка, что GET /units/pick-route не перехватывается маршрутом /{unit_id} с ошибкой 422."""
    from starlette.testclient import TestClient
    from app.main import app
    from app.core.security import get_current_user
    from app.models.users import User

    mock_user = MagicMock(spec=User)
    mock_user.id = 1
    mock_user.is_superuser = True
    mock_user.permissions = ["units.issue", "production_tasks.view"]
    mock_user.area = None

    app.dependency_overrides[get_current_user] = lambda: mock_user
    try:
        client = TestClient(app)
        res = client.get("/api/units/pick-route", headers={"Authorization": "Bearer test"})
        assert res.status_code != 422, f"Got 422: {res.text}"
        assert res.status_code == 200
        data = res.json()
        assert "items" in data
        assert "total_items" in data
    finally:
        app.dependency_overrides.clear()

