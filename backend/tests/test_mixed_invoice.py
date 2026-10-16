"""Смешанный счёт (16.10): тип строки по серии, изделия без этапов."""
from types import SimpleNamespace as NS

from app.services.import_template import Template, TemplateRow, fill_from_name
from app.services.production_orders import without_route
from app.services.schedule_import import detect_type

COLUMNS = [
    {"title": "Дата отгрузки", "role": "ship_date"},
    {"title": "№ счёта", "role": "invoice"},
    {"title": "Серия", "role": "property", "code": "серия"},
    {"title": "Размер", "role": "size", "codes": ["ширина", "высота"]},
    {"title": "Цвет", "role": "property", "code": "цвет", "from_name": True},
    {"title": "Наименование", "role": "name"},
    {"title": "Кол-во дверей", "role": "qty"},
]


def _type(tid, name, series):
    prop = NS(id=tid * 10, code="серия", value_type="list", options=[NS(value=s, label=None, params={}, is_active=True) for s in series])
    return NS(id=tid, name=name, model_property_id=prop.id, properties=[prop])


def _row(name):
    tpl = Template.of({"columns": COLUMNS})
    row = TemplateRow(line_no=1, cells=["", "", "", "", "", name, "1"])
    row.name_text = name
    fill_from_name(tpl, row, "серия")
    return tpl, row


SHIELD = _type(12, "Щитовая дверь", ["В-15", "Е-5", "Н-1 ВО"])
TSARG = _type(13, "Царговая дверь", ["С-2", "МОН-36", "МГ-22"])


def test_type_by_series():
    for name, want in (
        ("С-2 400х2000 - ПЭТ Бежевый (cream silk) (стекло Сатин)", "Царговая дверь"),
        ("В-15 (м9 кромка 4х) 600х2000 - Полипропилен Аляска", "Щитовая дверь"),
        ("МОН-36 800х2000 - ПЭТ белый", "Царговая дверь"),
        ("МГ-22 700х2000 - экошпон", "Царговая дверь"),
    ):
        tpl, row = _row(name)
        assert detect_type([SHIELD, TSARG], tpl, row).name == want, name


def test_unknown_series_has_no_type():
    tpl, row = _row("Х-9 800х2000 - что-то")
    assert detect_type([SHIELD, TSARG], tpl, row) is None


def test_without_route_only_for_types_without_operations():
    tsarg = NS(stages=[], type=NS(operations=[]))
    shield_broken = NS(stages=[], type=NS(operations=[object()]))
    shield_ok = NS(stages=[object()], type=NS(operations=[object()]))
    untyped = NS(stages=[], type=None)
    assert without_route(tsarg) is True
    assert without_route(shield_broken) is False  # щитовая без маршрута — ошибка техкарты, не «без этапов»
    assert without_route(shield_ok) is False
    assert without_route(untyped) is False
