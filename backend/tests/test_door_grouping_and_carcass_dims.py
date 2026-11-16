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

    # Test with material_id (film line)
    from app.models.dictionaries import Material, Color
    mat = db.query(Material).first()
    if not mat:
        mat = Material(name="ПВХ", is_active=True)
        db.add(mat)
        db.flush()
    col = db.query(Color).first()
    if not col:
        col = Color(name="Дуб", is_active=True)
        db.add(col)
        db.flush()

    line_film = ProductionTaskLine(
        task_id=task.id,
        part_name="Стоевая 100",
        quantity_pieces=10,
        width_mm=100,
        length_m=2.0,
        material_id=mat.id,
        color_id=col.id,
        strip_width_mm=114,
    )
    db.add(line_film)
    db.flush()
    grp_film = line_group(db, line_film, "wrapping")
    assert grp_film is not None
    f_key, f_label = grp_film
    assert "Штрипс 114 мм" in f_label


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


def test_door_line_not_contaminated_by_carcass_item(db):
    user = db.query(User).first()
    user_id = user.id if user else 1

    from app.models.items import Item, ItemKind
    kind = db.query(ItemKind).first()
    carcass_item = Item(name="Каркас 22.5х910х2010", is_active=True, kind_id=kind.id if kind else 1)
    db.add(carcass_item)
    db.flush()

    order = ProductionOrder(name="Заказ тест", created_by=user_id)
    db.add(order)
    db.flush()

    ol = ProductionOrderLine(order_id=order.id, item_id=carcass_item.id, quantity=1, sort_order=1)
    db.add(ol)
    db.flush()

    task = ProductionTask(name="Кромка тест", area="kromka_shchitovykh_dverey", is_active=True, created_by=user_id)
    db.add(task)
    db.flush()

    door_line = ProductionTaskLine(
        task_id=task.id,
        order_line_id=ol.id,
        part_name="Дверь щитовая В-15 800х2000 ПВХ Бетон темный с молдингом под замок, кромка черная ABS 2мм",
        quantity_pieces=1,
        width_mm=0.0,
        length_m=0.0,
    )
    db.add(door_line)
    db.flush()

    task_out = _task_out(db, task)
    assert len(task_out.lines) == 1
    tl_out = task_out.lines[0]

    # Door should NOT have carcass thickness
    assert tl_out.thickness is None
    # Door width should be resolved from part_name/fallback chars, not carcass 910
    assert tl_out.width_mm == 800.0
    assert tl_out.length_m == 2.0
    # No bogus thickness in item chars
    th_chars = [c for c in tl_out.item_chars if c.get("code") == "толщина"]
    assert len(th_chars) == 0
