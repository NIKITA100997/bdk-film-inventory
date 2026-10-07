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


def test_milling_program_parse_and_suggest():
    from types import SimpleNamespace

    from app.services.milling_programs import door_spec_from_text, parse_program, suggest

    assert parse_program("Grafiti_5_800х2000_2").series == "В-34"
    assert parse_program("В5_F3_700х2000_1").series == "В-5/Ф3"
    progs = [SimpleNamespace(name=n) for n in ("В10.1_800х2000_(М5х3)", "В10.2_800х2000_(М5х3)", "В5_F3_800х2000_1", "В5_F3_800х2000_2", "Е14.2_(М5х3)")]
    ver, mold = door_spec_from_text("В-10.2 (м5х3 кромка 4х) 800х2000 - ПЭТ Бежевый")
    assert suggest(progs, "В-10", 800, ver, mold, True) == "В10.2_800х2000_(М5х3)"
    assert suggest(progs, "В-5/Ф3", 800, None, None, False) == "В5_F3_800х2000_1"
    assert suggest(progs, "В-5/Ф3", 800, None, None, True) == "В5_F3_800х2000_2"
    assert suggest(progs, "Е-14", 700, "2", "М5Х3", True) == "Е14.2_(М5х3)"
    assert suggest(progs, "В-10", 630, "2", "М5Х3", False) is None  # нестандарт — конструктор


def test_invoice_1c_rows_name_and_qty():
    from app.services.import_template import Template, fill_from_name, parse_rows

    tpl = Template.of({"columns": [
        {"title": "Дата отгрузки", "role": "ship_date"}, {"title": "№ счёта", "role": "invoice"},
        {"title": "Серия", "role": "property", "code": "серия"}, {"title": "Размер", "role": "size", "codes": ["ширина", "высота"]},
        {"title": "Цвет", "role": "property", "code": "цвет", "from_name": True}, {"title": "Наименование", "role": "name"},
        {"title": "Кол-во дверей", "role": "qty"},
    ]})
    text = "В-19.1 (м5х3 кромка 4х) 700х2000 - Манхэттен кромка черная ABS 2мм    10\nВ-15 (м9 кромка 4х) 600х2000 - Полипропилен Аляска кромка черная ABS 2мм\t30"
    rows, errors = parse_rows(text, tpl)
    assert not errors and [r.qty for r in rows] == [10, 30]
    for r in rows:
        fill_from_name(tpl, r, "серия")
    assert tpl.column_text(rows[0], "серия") == "В-19.1" and tpl.column_text(rows[0], "ширина") == "700х2000"
    assert tpl.color_text(rows[1], "цвет") == "Полипропилен Аляска"
