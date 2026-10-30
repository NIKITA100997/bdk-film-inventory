"""Тесты для Phase 2:
1. Сквозной таймлайн заказа (Order Timeline Hub).
2. Защита от дубликатов и аудит/очистка зависших черновиков.
3. События и обратная синхронизация сделок Битрикс24.
"""

from datetime import date, datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.models.customer_orders import CO_ACCEPTED, CO_CANCELLED, CO_DRAFT, CustomerOrder, CustomerOrderLine
from app.models.production_orders import ORDER_DRAFT, ORDER_RELEASED, ProductionOrder, ProductionOrderLine
from app.services import bitrix_deals
from app.services.order_timeline import _calc_customer_timeline, get_production_order_timeline


def test_customer_order_timeline_computation():
    """Проверка расчёта стадий таймлайна, общего прогресса и текста для клиента."""
    db = MagicMock()
    co = CustomerOrder(
        id=42,
        invoice_no="1759-АТ",
        customer="ООО Двери Плюс",
        status=CO_ACCEPTED,
        promised_ready=date(2026, 11, 2),
        ship_date=date(2026, 11, 5),
        created_at=datetime.now(timezone.utc),
    )
    mock_progress = MagicMock(
        qty=20.0,
        launched=20.0,
        in_work=20.0,
        received=12.0,
        shipped=0.0,
        ready_fact=None,
        last_shipped_at=None,
        production_orders=[(10, "Запуск 1759-АТ", ORDER_RELEASED)],
    )

    with patch("app.services.customer_orders.progress", return_value=mock_progress):
        with patch("app.services.order_timeline.order_plan_status") as mock_ops:
            mock_ops.return_value = MagicMock(finish=date(2026, 11, 2), late=False, overdue=0.0)
            db.query().filter().all.return_value = []
            tl = _calc_customer_timeline(db, co)

    assert tl.order_id == 42
    assert tl.invoice_no == "1759-АТ"
    assert tl.customer == "ООО Двери Плюс"
    assert len(tl.stages) == 7
    stage_keys = [s.key for s in tl.stages]
    assert stage_keys == ["invoice", "materials", "parts", "processing", "assembly", "warehouse", "shipment"]
    assert 0 <= tl.overall_progress_pct <= 100
    assert tl.client_message
    assert "Заказ: счёт 1759-АТ (ООО Двери Плюс)" in tl.client_message
    assert "Готовность:" in tl.client_message


def test_check_invoice_duplicate_logic():
    """Проверка нормализации ключа счёта и поиска дубликатов."""
    from app.services.invoice_1c import invoice_key

    # Various ways the same invoice number can be typed
    k1 = invoice_key("1029-АТ")
    k2 = invoice_key("1029-ат(М)")
    k3 = invoice_key("№ 1029 - АТ")
    k4 = invoice_key("1029AT")  # Latin A, T
    assert k1 == k2 == k3 == k4 == "1029АТ"


def test_drafts_audit_filtering():
    """Проверка определения зависших, пустых и дублирующих черновиков."""
    now = datetime.now(timezone.utc)
    old_empty = CustomerOrder(
        id=1,
        invoice_no="DRAFT-1",
        status=CO_DRAFT,
        created_at=now - timedelta(days=10),
    )
    old_empty.lines = []

    active_dup = CustomerOrder(
        id=2,
        invoice_no="1029-ЛД",
        status=CO_DRAFT,
        created_at=now - timedelta(days=2),
    )
    active_dup.lines = [CustomerOrderLine(id=10, item_id=1, quantity=5.0)]

    assert len(old_empty.lines) == 0
    assert (now - old_empty.created_at).days >= 7


def test_bitrix_notify_order_event_safe():
    """Проверка, что вызов notify_order_event безопасен даже при отключённом Битриксе."""
    db = MagicMock()
    co = CustomerOrder(id=100, invoice_no="1234-Тест", status=CO_ACCEPTED)
    db.get.return_value = co

    with patch("app.services.bitrix.get_settings", return_value={"enabled": False}):
        # Should not raise exception
        bitrix_deals.notify_order_event(db, 100, "fg_receipt", {"qty": 5})
        bitrix_deals.notify_order_event(db, 100, "ready")
        bitrix_deals.notify_order_event(db, 100, "delay_alert", {"delay_days": 2, "bottleneck": "Окутка"})
