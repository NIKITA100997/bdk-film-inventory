from datetime import date, datetime, timezone

from app.services.action_requests import describe
from app.services.period_guard import _as_date


def test_describe_known_actions():
    assert describe(None, "POST", "/api/units/15/return", {"return_length_m": 3}) == "Возврат рулона ПЛ-15 на склад"
    assert describe(None, "POST", "/api/production-tasks/7/lines/9/reports/batch",
                    [{"good_pieces": 10, "defect_pieces": 0}, {"good_pieces": 0, "defect_pieces": 2}]) == (
        "Отчёт о производстве: задание №7, строка 9: годных 10, брак 2")
    assert describe(None, "POST", "/api/finished-goods/shipments", {"invoice_no": "А-12"}) == "Отгрузка по счёту (счёт А-12)"


def test_describe_fallback():
    assert describe(None, "PATCH", "/api/something/5", None) == "Изменение: /something/5"


def test_as_date_moscow():
    # 21:30 UTC 31.10 — это уже 1 ноября по Москве
    assert _as_date(datetime(2026, 10, 31, 21, 30, tzinfo=timezone.utc)) == date(2026, 11, 1)
    assert _as_date(date(2026, 9, 30)) == date(2026, 9, 30)
    assert _as_date(None) is None
