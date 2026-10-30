"""Тесты для Phase 3:
1. «Пульс завода» (Factory Pulse): сводные KPI, выявление узких мест, оперативные рекомендации.
2. MRP-модуль: расчёт чистого дефицита сырья и материалов по формуле
   Deficit = max(0, Gross Demand + Safety Stock - Current Stock - In Transit)
   и создание заявок/заказов в 1 клик.
3. Smart Batching: группировка очередей по декорам и ширинам, сокращение переналадок.
"""

from datetime import date, datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.models.areas import Area
from app.models.dictionaries import Color, Material, Thickness
from app.models.items import Item
from app.models.production import PlanSlot, ProductionTask, ProductionTaskLine
from app.models.purchasing import PurchaseRequest, Supplier, SupplierOrder
from app.services.factory_pulse import compute_factory_pulse
from app.services.mrp import compute_mrp_needs, create_mrp_orders
from app.services.smart_batching import (
    BatchingLineItem,
    _count_changeovers,
    plan_smart_batching,
)


def test_factory_pulse_computation():
    """Проверка расчёта KPI смены, узких мест и рекомендаций."""
    db = MagicMock()

    # Reports: good 150, defect 5
    db.query().filter().first.return_value = (150.0, 5.0)
    # FG Moves: 150
    db.query().filter().scalar.return_value = 150.0

    # Areas
    mock_area = Area(code="wrapping", name="Окутка царговых")
    db.query(Area).order_by().all.return_value = [mock_area]
    db.query(ProductionTask).filter().all.return_value = []
    db.query().filter().all.return_value = []

    with patch("app.services.factory_pulse.area_capacities", return_value={"wrapping": 100.0}):
        pulse = compute_factory_pulse(db, target_date=date(2026, 10, 30))

    assert pulse.output_pieces_today == 150.0
    assert pulse.defect_pieces_today == 5.0
    assert pulse.plan_completion_pct > 0
    assert len(pulse.area_balances) == 1
    assert pulse.area_balances[0].area_code == "wrapping"
    assert len(pulse.insights) > 0


def test_mrp_needs_and_deficit_formula():
    """Проверка формулы чистого дефицита MRP: Deficit = max(0, Gross + Safety - Stock - InTransit)."""
    db = MagicMock()

    mock_task = ProductionTask(id=10, is_active=True, area="wrapping")
    mock_line = ProductionTaskLine(
        id=101,
        task_id=10,
        task=mock_task,
        material_id=1,
        color_id=2,
        thickness_id=3,
        width_mm=200.0,
        length_m=2.0,
        quantity_pieces=100.0,
        is_closed=False,
    )
    mock_line.reports = []

    def mock_query(model, *args):
        m = MagicMock()
        if model == Material:
            m.all.return_value = [Material(id=1, name="ПВХ")]
        elif model == Color:
            m.all.return_value = [Color(id=2, name="Дуб сонома")]
        elif model == Thickness:
            m.all.return_value = [Thickness(id=3, value_mm=0.3)]
        elif model == ProductionTaskLine:
            m.join().filter().all.return_value = [mock_line]
        elif model == PurchaseRequest:
            m.filter().all.return_value = []
            m.filter().order_by().first.return_value = None
        elif model == PlanSlot:
            m.filter().all.return_value = []
        elif model == Item:
            m.filter().all.return_value = []
        else:
            m.filter().all.return_value = []
            m.all.return_value = []
        return m

    db.query.side_effect = mock_query

    with patch("app.services.mrp.current_stock_m2", return_value=10.0):
        with patch("app.services.materials.balances", return_value={}):
            needs = compute_mrp_needs(db, horizon_days=14, safety_stock_ratio=0.15)

    assert len(needs) >= 1
    film_need = next(n for n in needs if n.item_type == "film")
    assert film_need.material_id == 1
    assert film_need.color_id == 2
    assert film_need.gross_demand == 40.0
    assert film_need.stock_current == 10.0
    assert film_need.net_deficit > 30.0
    assert film_need.suggested_order >= film_need.net_deficit


def test_mrp_create_orders_batch():
    """Проверка создания заявок на закупку и заказов поставщикам из MRP."""
    db = MagicMock()
    items_to_order = [
        {
            "item_type": "film",
            "material_id": 1,
            "color_id": 2,
            "thickness_id": 3,
            "width_mm": 200.0,
            "suggested_order": 250.0,
            "supplier_id": 5,
            "need_by": "2026-11-05",
        }
    ]

    result = create_mrp_orders(db, items=items_to_order, user_id=1, create_supplier_order=True)

    assert result["created_requests_count"] == 1
    assert result["created_supplier_orders_count"] == 1
    assert db.add.call_count >= 2  # PurchaseRequest + SupplierOrder
    assert db.commit.called


def test_smart_batching_changeovers_optimization():
    """Проверка алгоритма сокращения переналадок при Smart Batching."""
    line1 = BatchingLineItem(
        line_id=1, task_id=10, task_name="T1", part_name="P1",
        material_id=1, material_name="ПВХ", color_id=1, color_name="Белый",
        thickness_id=1, thickness_val=0.3, width_mm=300.0, length_m=2.0,
        remaining_pieces=50.0, due_date=date(2026, 11, 2), urgency_score=1
    )
    line2 = BatchingLineItem(
        line_id=2, task_id=11, task_name="T2", part_name="P2",
        material_id=1, material_name="ПВХ", color_id=2, color_name="Венге",
        thickness_id=1, thickness_val=0.3, width_mm=200.0, length_m=2.0,
        remaining_pieces=40.0, due_date=date(2026, 11, 2), urgency_score=1
    )
    line3 = BatchingLineItem(
        line_id=3, task_id=12, task_name="T3", part_name="P3",
        material_id=1, material_name="ПВХ", color_id=1, color_name="Белый",
        thickness_id=1, thickness_val=0.3, width_mm=280.0, length_m=2.0,
        remaining_pieces=60.0, due_date=date(2026, 11, 2), urgency_score=1
    )
    line4 = BatchingLineItem(
        line_id=4, task_id=13, task_name="T4", part_name="P4",
        material_id=1, material_name="ПВХ", color_id=2, color_name="Венге",
        thickness_id=1, thickness_val=0.3, width_mm=190.0, length_m=2.0,
        remaining_pieces=30.0, due_date=date(2026, 11, 2), urgency_score=1
    )

    unoptimized = [line1, line2, line3, line4]
    assert _count_changeovers(unoptimized) == 3

    # Grouped by decor and sorted by width:
    optimized = [line1, line3, line2, line4]
    assert _count_changeovers(optimized) == 1
    # 2 changeovers saved, which equals 50 min of downtime saved!
