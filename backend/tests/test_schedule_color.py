from types import SimpleNamespace as NS

from app.services.schedule_import import _values_for_row
from app.services.shield_schedule import ScheduleRow


def _type():
    def prop(pid, code, vt, options=()):
        return NS(id=pid, code=code, value_type=vt, options=list(options), is_required=True)

    opt = lambda i, v, params=None: NS(id=i, value=v, is_active=True, params=params or {})  # noqa: E731
    return NS(
        name="Щитовая дверь",
        properties=[
            prop(1, "серия", "list", [opt(10, "В-10", {"кромка": "abs"})]),
            prop(2, "ширина", "number"),
            prop(3, "высота", "number"),
            prop(4, "цвет", "list", [opt(84, "ПЭТ Бежевый (cream silk)"), opt(88, "Эмалит белый")]),
            prop(5, "стекло", "text"),
            prop(6, "молдинг", "bool"),
            prop(7, "замок", "bool"),
            prop(8, "кромка", "list", [opt(20, "abs"), opt(21, "aluminum")]),
            prop(9, "цвет_кромки", "text"),
        ],
    )


def _row(color):
    return ScheduleRow(ship_date=None, invoice_no="1", series_text="В-10.2", size_text="800х2000", color_text=color,
                       name_text=f"В-10.2 800х2000 - {color} кромка черная ABS 2мм", doors_qty=1)


def test_color_from_schedule_matches_option_without_brackets():
    values, errors = _values_for_row(_type(), _row("ПЭТ Бежевый"))
    assert errors == []
    assert values[4] == 84


def test_unknown_color_is_a_readable_error():
    values, errors = _values_for_row(_type(), _row("Белое дерево"))
    assert values == {}
    assert errors and "Белое дерево" in errors[0]


def test_color_parsed_from_name():
    from app.services.schedule_import import color_from_name

    assert color_from_name("В-10.2 (м5х3 кромка 4х) 800х2000 - ПЭТ Бежевый (cream silk) кромка черная ABS 2мм", "ПЭТ Бежевый") == "ПЭТ Бежевый (cream silk)"
    assert color_from_name("А-1 800х2000 - Манхэттен (стекло Зеркало ГРАФИТ) (Защелка Border room) кромка Black", "Манхэттен") == "Манхэттен"
    assert color_from_name("В-5 кромка с 4-х сторон 900х2000 - Белое дерево кромка черная ABS 2мм", "Белое дерево") == "Белое дерево"
    assert color_from_name("без дефиса", "Полипропилен Аляска") == "Полипропилен Аляска"


def test_hardware_brackets_are_not_color():
    from app.services.schedule_import import color_from_name

    name = "В-19 800х2000 - Полипропилен INVISIBLE Белый грунтовочный (PL410 + петли AGB Eclipse 3.0) кромка Black"
    assert color_from_name(name, "") == "Полипропилен INVISIBLE Белый грунтовочный"


def _index(*skus):
    import re

    from app.services.sku_matching import SkuMatchIndex

    items = [NS(id=i, material=NS(name=m), color=NS(name=c), color_id=hash(c), material_id=hash(m), thickness=NS(value_mm=0.14))
             for i, (m, c) in enumerate(skus, start=1)]
    return SkuMatchIndex(
        color_by_normalized={},
        skus_by_color_id={},
        combined_label_to_sku={re.sub(r"\s+", " ", f"{s.material.name} {s.color.name}".lower()): s for s in items},
        sku_by_id={s.id: s for s in items},
    )


def test_film_picked_like_okutka_tasks():
    from app.services.schedule_import import film_for_color

    idx = _index(("ПЭТ 2Д", "Белый"), ("ПЭТ 3Д", "Белый"), ("ПЭТ 2Д", "Бежевый"), ("Полипропилен", "Аляска"))
    # ПЭТ 2Д и 3Д одного цвета — материал «ПЭТ», тип решается у детали
    assert film_for_color(None, "ПЭТ Белый", idx) == ("ПЭТ", "Белый", 0.14)
    assert film_for_color(None, "Полипропилен Аляска", idx) == ("Полипропилен", "Аляска", 0.14)
    assert film_for_color(None, "Bolton Oak", idx) is None


def test_door_color_found_by_synonym():
    """Цвет двери = плёнка: текст из графика — синоним варианта."""
    from app.services.door_colors import find_option

    opt = NS(id=1, value="ПВХ Бетон темный", is_active=True,
             params={"материал_плёнки": "ПВХ", "цвет_плёнки": "Бетон темный", "синонимы": ["Бетон тёмный ВДМ"]})
    prop = NS(options=[opt])
    assert find_option(prop, "Бетон тёмный ВДМ") is opt
    assert find_option(prop, "пвх бетон тёмный") is opt
    assert find_option(prop, "Бетон снежный") is None
