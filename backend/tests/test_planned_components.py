from types import SimpleNamespace

from app.services.components import planned_components


def c(id, sort, alt=None, defect=False):
    return SimpleNamespace(id=id, sort_order=sort, alt_group=alt, from_defect=defect)


def test_plain_rows_kept():
    rows = [c(1, 1), c(2, 2)]
    assert [x.id for x in planned_components(rows)] == [1, 2]


def test_alternatives_first_only():
    # 26х30: основной — заготовка большего размера, запасной — брак п/ф
    rows = [c(3, 2, alt=1), c(1, 1, alt=1), c(5, 3)]
    assert [x.id for x in planned_components(rows)] == [1, 5]


def test_defect_never_planned():
    # 36х100 — только из брака 36х108: потребность в заготовке не создаётся
    rows = [c(1, 1, defect=True)]
    assert planned_components(rows) == []


def test_defect_first_in_group_falls_to_next():
    rows = [c(1, 1, alt=7, defect=True), c(2, 2, alt=7)]
    assert [x.id for x in planned_components(rows)] == [2]
