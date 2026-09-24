import pytest

from app.services.expressions import (
    ExpressionError,
    OptionRef,
    evaluate,
    evaluate_condition,
    evaluate_number,
    names_in_template,
    render_template,
)

CTX = {
    "ширина": 800.0,
    "высота": 2000.0,
    "серия": OptionRef("В-10", {"толщина_каркаса": 24.0, "толщина_панели": 6.0, "кромка": "abs"}),
    "стекло": False,
    "замок": True,
    "цвет": "ПЭТ Бежевый",
    "пусто": None,
}


def test_arithmetic_on_properties():
    assert evaluate_number("ширина + 10", CTX) == 810
    assert evaluate_number("(ширина + 10) * 2 / 4", CTX) == 405


def test_option_params_via_dot():
    assert evaluate_number("серия.толщина_каркаса", CTX) == 24
    assert evaluate("серия.кромка", CTX) == "abs"


def test_option_compares_as_string_case_insensitive():
    assert evaluate_condition('серия == "в-10"', CTX)
    assert evaluate_condition('серия in ("А-1", "В-10")', CTX)
    assert not evaluate_condition('серия != "В-10"', CTX)


def test_conditions_with_bool_logic():
    assert evaluate_condition('серия.кромка == "abs" and not стекло', CTX)
    assert evaluate_condition("замок or стекло", CTX)
    assert evaluate_condition("ширина >= 700 and ширина < 900", CTX)
    assert evaluate_condition("", CTX)


def test_if_else_and_functions():
    assert evaluate_number("2 if ширина > 700 else 1", CTX) == 2
    assert evaluate_number("max(ширина, высота) / 1000", CTX) == 2
    assert evaluate_number("ceil(ширина / 300)", CTX) == 3


def test_template_renders_like_schedule_notation():
    assert render_template("Каркас {ширина+10}х{высота+10}х{серия.толщина_каркаса}", CTX) == "Каркас 810х2010х24"
    assert render_template("Панель {серия.толщина_панели}х{ширина+10}х{высота+10} {цвет}", CTX) == "Панель 6х810х2010 ПЭТ Бежевый"


def test_template_names_are_collected_for_validation():
    assert names_in_template("Каркас {ширина+10}х{серия.толщина_каркаса}") == {"ширина", "серия"}


@pytest.mark.parametrize(
    "expr",
    [
        "__import__('os').system('x')",
        "ширина.__class__",
        "open('x')",
        "[x for x in (1, 2)]",
        "lambda: 1",
    ],
)
def test_forbidden_constructs_are_rejected(expr):
    with pytest.raises(ExpressionError):
        evaluate(expr, CTX)


def test_clear_errors_for_missing_data():
    with pytest.raises(ExpressionError, match="Неизвестное свойство «глубина»"):
        evaluate("глубина + 1", CTX)
    with pytest.raises(ExpressionError, match="Не заполнено свойство «пусто»"):
        evaluate("пусто + 1", CTX)
    with pytest.raises(ExpressionError, match="не задан параметр «вес»"):
        evaluate("серия.вес", CTX)
    with pytest.raises(ExpressionError, match="должна давать число"):
        evaluate_number("цвет", CTX)
