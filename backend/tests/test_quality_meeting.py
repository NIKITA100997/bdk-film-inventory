import datetime as dt
from app.services.quality_meeting import (
    compute_quality_meeting,
    generate_recommendations,
)


def test_compute_quality_meeting_empty():
    today = dt.date.today()
    res = compute_quality_meeting([], today, today)
    assert res.total_defect_pieces == 0.0
    assert res.total_good_pieces == 0.0
    assert res.total_defect_rate_percent == 0.0
    assert len(res.pareto_reasons) == 0
    assert "отсутствует" in res.zone_a_summary


def test_compute_quality_meeting_pareto_80_20():
    today = dt.date.today()
    raw = [
        # Причина 1: 50 шт (50%)
        {
            "defect_pieces": 50,
            "good_pieces": 950,
            "reason_code": "BUBBLES",
            "reason_name": "Пузыри при окутке",
            "line_id": 1,
            "line_name": "Линия Barberan 1",
            "area_code": "wrapping",
            "area_name": "Окутка",
            "color_id": 101,
            "color_name": "Дуб сонома",
            "cost_rub": 10000.0,
            "film_used_m": 500.0,
        },
        # Причина 2: 30 шт (30%) -> в сумме 80% (Зона А!)
        {
            "defect_pieces": 30,
            "good_pieces": 970,
            "reason_code": "CHIP",
            "reason_name": "Скол торца",
            "line_id": 2,
            "line_name": "Линия Barberan 2",
            "area_code": "wrapping",
            "area_name": "Окутка",
            "color_id": 102,
            "color_name": "Белый матовый",
            "cost_rub": 6000.0,
            "film_used_m": 300.0,
        },
        # Причина 3: 15 шт (15%) -> Зона B
        {
            "defect_pieces": 15,
            "good_pieces": 985,
            "reason_code": "SCRATCH",
            "reason_name": "Царапина плёнки",
            "line_id": 1,
            "line_name": "Линия Barberan 1",
            "area_code": "wrapping",
            "area_name": "Окутка",
            "color_id": 101,
            "color_name": "Дуб сонома",
            "cost_rub": 3000.0,
            "film_used_m": 150.0,
        },
        # Причина 4: 5 шт (5%) -> Зона C
        {
            "defect_pieces": 5,
            "good_pieces": 995,
            "reason_code": "OTHER",
            "reason_name": "Прочее",
            "line_id": 2,
            "line_name": "Линия Barberan 2",
            "area_code": "wrapping",
            "area_name": "Окутка",
            "color_id": 103,
            "color_name": "Венге",
            "cost_rub": 1000.0,
            "film_used_m": 50.0,
        },
    ]

    report = compute_quality_meeting(raw, today, today, area="wrapping")

    assert report.total_defect_pieces == 100.0
    assert report.total_good_pieces == 3900.0
    assert report.total_defect_rate_percent == round(100.0 / 3900.0 * 100, 2)
    assert report.total_loss_rub > 0

    # Проверка Парето-распределения
    assert len(report.pareto_reasons) == 4
    # Первое место - Пузыри
    assert report.pareto_reasons[0].reason_code == "BUBBLES"
    assert report.pareto_reasons[0].defect_pieces == 50.0
    assert report.pareto_reasons[0].share_percent == 50.0
    assert report.pareto_reasons[0].cumulative_percent == 50.0
    assert report.pareto_reasons[0].is_zone_a is True

    # Второе место - Сколы (кумулятивно 80%)
    assert report.pareto_reasons[1].reason_code == "CHIP"
    assert report.pareto_reasons[1].defect_pieces == 30.0
    assert report.pareto_reasons[1].share_percent == 30.0
    assert report.pareto_reasons[1].cumulative_percent == 80.0
    assert report.pareto_reasons[1].is_zone_a is True

    # Третье место - Царапины (уже выше 80%, значит не Зона А)
    assert report.pareto_reasons[2].reason_code == "SCRATCH"
    assert report.pareto_reasons[2].is_zone_a is False

    # Четвертое место - Прочее
    assert report.pareto_reasons[3].reason_code == "OTHER"
    assert report.pareto_reasons[3].is_zone_a is False

    # Проверка сводки Зоны А
    assert "80" in report.zone_a_summary
    assert "Пузыри при окутке" in report.zone_a_summary

    # Проверка рекомендаций
    rec_text = " ".join(report.recommended_actions).lower()
    assert "температур" in rec_text or "ролик" in rec_text or "заточк" in rec_text

    # Проверка антирейтинга станков
    assert len(report.machine_ranking) == 2
    # Линия 1: 50 + 15 = 65 шт брака
    assert report.machine_ranking[0].line_id == 1
    assert report.machine_ranking[0].defect_pieces == 65.0
    assert report.machine_ranking[0].top_reason == "Пузыри при окутке"

    # Линия 2: 30 + 5 = 35 шт брака
    assert report.machine_ranking[1].line_id == 2
    assert report.machine_ranking[1].defect_pieces == 35.0

    # Проверка антирейтинга цветов
    assert len(report.decor_ranking) == 3
    # Дуб сонома: 50 + 15 = 65 шт
    assert report.decor_ranking[0].color_name == "Дуб сонома"
    assert report.decor_ranking[0].defect_pieces == 65.0


def test_quality_meeting_api_endpoint():
    from unittest.mock import MagicMock
    from starlette.testclient import TestClient
    from app.main import app
    from app.core.security import get_current_user
    from app.models.users import User

    mock_user = MagicMock(spec=User)
    mock_user.id = 1
    mock_user.is_superuser = True
    mock_user.permissions = ["reports.view"]
    mock_user.area = None

    app.dependency_overrides[get_current_user] = lambda: mock_user
    try:
        client = TestClient(app)
        today = dt.date.today().isoformat()
        res = client.get(f"/api/reports/quality-meeting?date_from={today}&date_to={today}", headers={"Authorization": "Bearer test"})
        assert res.status_code == 200
        data = res.json()
        assert "total_defect_pieces" in data
        assert "pareto_reasons" in data
        assert "machine_ranking" in data
        assert "decor_ranking" in data
        assert "zone_a_summary" in data
        assert "recommended_actions" in data
    finally:
        app.dependency_overrides.clear()
