from types import SimpleNamespace as NS

from app.services import line_options as lo


def _type():
    return NS(properties=[
        NS(id=1, code="серия", name="Серия", value_type="text", role="construction", operation=None),
        NS(id=2, code="цвет_кромки", name="Цвет кромки", value_type="text", role="execution", operation="Кромка"),
        NS(id=3, code="тип_стекла", name="Тип стекла", value_type="text", role="execution", operation="Сборка"),
    ])


def test_split_values_moves_execution_to_line():
    keep, opts = lo.split_values(None, _type(), {1: "В-12", 2: "черная ABS 2мм", 3: ""})
    assert keep == {1: "В-12"}
    assert opts == [{"code": "цвет_кромки", "name": "Цвет кромки", "value": "черная ABS 2мм", "op": "Кромка"}]


def test_instruction_only_for_its_operation():
    opts = [
        {"code": "цвет_кромки", "name": "Цвет кромки", "value": "черная ABS 2мм", "op": "Кромка"},
        {"code": "уплотнитель", "name": "Уплотнитель", "value": "серо-белый УК-6", "op": None},
    ]
    assert lo.instruction_for(opts, "Кромка") == "цвет кромки: черная ABS 2мм; уплотнитель: серо-белый УК-6"
    assert lo.instruction_for(opts, "Склейка щитов") == "уплотнитель: серо-белый УК-6"


def test_merge_and_key():
    base = [{"code": "a", "name": "A", "value": "1", "op": None}]
    m = lo.merge(base, [{"code": "b", "name": "B", "value": "2", "op": None}])
    assert {o["code"] for o in m} == {"a", "b"}
    assert lo.merge(m, [{"code": "a", "name": "A", "value": "", "op": None}]) == [{"code": "b", "name": "B", "value": "2", "op": None}]
    assert lo.key(m) == lo.key(list(reversed(m)))


def test_seal_option():
    assert lo.seal_option("Коробка с упл. (графит УК-6) телескоп МДФ 32х75х2070 (Бьянко)")[0]["value"] == "графит УК-6"
    assert lo.seal_option("Наличник телескоп 8х70х2150 (Бьянко)") == []
