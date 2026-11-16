import pytest
from app.db.session import SessionLocal
from app.models.areas import Area
from app.models.users import User
from app.models.production import ProductionTask, ProductionTaskLine
from app.models.production_orders import ProductionOrder, ProductionOrderLine
from app.services.line_groups import fallback_door_chars, line_group
from app.services.door_cols import door_cols
from app.services.job_card import build_job_card
from app.services.task_print import print_sheets
from app.api.production import _task_out, _line_effective_strip_width


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def test_fallback_door_chars_extraction():
    name = "Дверь щитовая В-5 300х1850 ПЭТ Белый, кромка ПЭТ Белая 1мм"
    chars = fallback_door_chars(name)
    by_code = {c["code"]: c["value"] for c in chars}
    assert by_code["серия"] == "В-5"
    assert by_code["ширина"] == "300 мм"
    assert by_code["высота"] == "1850 мм"
    assert by_code["кромка"] == "ПЭТ"
    assert "Белая" in by_code["цвет_кромки"]
    assert "Белый" in by_code["цвет"]


def test_line_group_uniform_formatting(db):
    user = db.query(User).first()
    user_id = user.id if user else 1

    area_code = "kromka_shchitovykh_dverey"
    area = db.get(Area, area_code)
    if not area:
        area = Area(code=area_code, name="Кромка щитовых дверей", group_props=["кромка", "цвет_кромки", "ширина", "высота", "серия", "цвет"])
        db.add(area)
        db.flush()

    task = ProductionTask(name="Тест Кромка", area=area_code, is_active=True, created_by=user_id)
    db.add(task)
    db.flush()

    line = ProductionTaskLine(
        task_id=task.id,
        part_name="Дверь щитовая В-5 300х1850 ПЭТ Белый, кромка ПЭТ Белая 1мм",
        quantity_pieces=10,
        width_mm=300,
        length_m=1.85,
    )
    db.add(line)
    db.flush()

    grp = line_group(db, line, area_code, chars=None)
    assert grp is not None
    key, label = grp
    assert "ПЭТ" in label
    assert "300 мм" in label
    assert "1850 мм" in label
    assert "В-5" in label
    assert "Белый" in label


def test_carcass_dims_and_no_strip_width(db):
    user = db.query(User).first()
    user_id = user.id if user else 1

    task = ProductionTask(name="Тест Сборка каркасов", area="sborka_karkasov", is_active=True, created_by=user_id)
    db.add(task)
    db.flush()

    line = ProductionTaskLine(
        task_id=task.id,
        part_name="Каркас 22.5х810х2010",
        quantity_pieces=5,
        width_mm=810,
        length_m=0.0,
        material_id=None,
        strip_width_mm=None,
    )
    db.add(line)
    db.flush()

    # strip_width must be None (no film!)
    sw = _line_effective_strip_width(line)
    assert sw is None

    # Job card output
    task_out = _task_out(db, task)
    card = build_job_card(db, task, task_out)
    assert len(card.lines) == 1
    cl = card.lines[0]
    assert cl.strip_width_mm is None
    assert "2010 x 810 x 22.5" in cl.dimensions
    assert not cl.dimensions.startswith("0 x")

    # Print sheet output
    sheets = print_sheets(db, [task])
    assert len(sheets) == 1
    row = sheets[0]["rows"][0]
    assert row["size"] == "22.5х810х2010"
    assert row["color"] == ""
    assert row["edge"] == ""
