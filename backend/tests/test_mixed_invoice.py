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


def test_product_key_ignores_colour_and_size_signs():
    from app.services.schedule_import import decor_of, product_key

    assert product_key("Коробка с упл. (белый УК-6) телескоп МДФ 32*75*2070") == product_key(
        "Коробка с упл. телескоп МДФ 32х75х2070 (Бетон тёмный ВДМ)"
    )
    assert product_key("Плинтус МДФ 16×80×2070") == product_key("Плинтус МДФ 16х80х2070 (Белый)")
    assert product_key("Добор телескоп 10*100*2070") != product_key("Добор телескоп 10х150х2070")
    assert decor_of("Наличник телескоп 8х70х2150 (Бетон тёмный ВДМ)") == "Бетон тёмный ВДМ"
    assert decor_of("Наличник телескоп 8х70х2150") is None


def test_new_series_goes_to_type_with_same_letter():
    from app.services.schedule_import import add_series

    def typ(tid, name, opts):
        prop = NS(id=tid * 10, code="серия", value_type="list",
                  options=[NS(value=v, params=p, sort_order=i, is_active=True) for i, (v, p) in enumerate(opts)])
        return NS(id=tid, name=name, model_property_id=prop.id, properties=[prop])

    shield = typ(12, "Щитовая дверь", [("В-10", {"кромка": "abs", "толщина_каркаса": 24}), ("В-15", {"кромка": "abs", "толщина_каркаса": 24}),
                                       ("Е-5", {"кромка": "aluminum", "толщина_каркаса": 22.5})])
    tsarg = typ(13, "Царговая дверь", [("С-2", {}), ("МОН-36", {})])
    db = NS(flush=lambda: None)
    t, like = add_series(db, [shield, tsarg], "В-40.2")
    assert t.name == "Щитовая дверь" and like == "В-10"
    added = shield.properties[0].options[-1]
    assert added.value == "В-40" and added.params == {"кромка": "abs", "толщина_каркаса": 24}
    assert add_series(db, [shield, tsarg], "С-7")[0].name == "Царговая дверь"
    assert add_series(db, [shield, tsarg], "Х-9") is None  # буква ничья — не угадываем


def test_nested_decor_and_qualifiers():
    from app.services.schedule_import import decor_of, product_key, qualifiers, seal_of

    t = "Коробка с упл. (серо-белый УК-6) телескоп МДФ 32х75х2070 (ПЭТ Бежевый (cream silk))"
    assert decor_of(t) == "ПЭТ Бежевый (cream silk)"
    assert product_key(t) == product_key("Коробка с упл. (белый УК-6) телескоп МДФ 32*75*2070")
    # цвет уплотнителя — не уточнение позиции, выбирается при запуске (26.10)
    assert qualifiers(t, drop_decor=True) == ()
    assert seal_of(t) == "серо-белый УК-6"
    assert qualifiers("Коробка с упл. (белый УК-6) телескоп МДФ 32*75*2070", drop_decor=False) == ()
    # без «УК»: у позиции «с упл.» цвет в скобках — тоже уплотнитель (27.10)
    t2 = "Коробка с упл. (серо-белый) телескоп (серия Б) МДФ 32х70х2070 (Бьянко)"
    assert seal_of(t2) == "серо-белый"
    assert qualifiers(t2, drop_decor=True) == ("серия б",)
    assert seal_of("Наличник (белый) 8х70 (Бьянко)") is None
    assert qualifiers("Поперечная (серия Б) 30х110 (Дуб)", drop_decor=True) == ("серия б",)
    assert qualifiers("Наличник телескоп 8х70х2150 (Бьянко)", drop_decor=True) == ()
