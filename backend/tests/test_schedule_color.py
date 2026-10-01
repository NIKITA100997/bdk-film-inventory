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
