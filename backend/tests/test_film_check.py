from app.services.film_check import pet_of_material
from app.db.session import SessionLocal
import pytest


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()



def test_pet_of_material():
    assert pet_of_material("ПЭТ 3Д") == "3d"
    assert pet_of_material("ПЭТ 2Д") == "2d"
    assert pet_of_material("пэт 3д") == "3d"
    assert pet_of_material("ПЭТ 3D") == "3d"
    assert pet_of_material("PET 3D") == "3d"
    assert pet_of_material("ПЭТ 2D") == "2d"
    assert pet_of_material("PET 2D") == "2d"
    assert pet_of_material("ПВХ") is None
    assert pet_of_material("Полипропилен") is None
    assert pet_of_material(None) is None


def test_film_warnings_with_order_line(db):
    from app.models.areas import Area
    from app.models.dictionaries import Material
    from app.models.items import Item, ItemKind
    from app.models.production import ProductionTask, ProductionTaskLine
    from app.models.production_orders import ProductionOrder, ProductionOrderLine
    from app.models.users import User
    from app.services.film_check import film_warnings

    user = db.query(User).first()
    user_id = user.id if user else 1

    area = db.query(Area).first()
    area_code = area.code if area else "tsargovye"

    kind = db.query(ItemKind).first()
    kind_id = kind.id if kind else 1

    po = ProductionOrder(name="Тестовый запуск", created_by=user_id)
    db.add(po)
    db.flush()

    item_2d = Item(name="Дверь 2D", kind_id=kind_id, pet_type="2d")
    mat_3d = Material(name="PET 3D")
    db.add_all([item_2d, mat_3d])
    db.flush()

    task = ProductionTask(production_order_id=po.id, area=area_code, created_by=user_id)
    db.add(task)
    db.flush()

    ol = ProductionOrderLine(order_id=po.id, item_id=item_2d.id, quantity=1)
    db.add(ol)
    db.flush()

    # Task line without part_id, but with order_line_id
    line = ProductionTaskLine(
        task_id=task.id,
        order_line_id=ol.id,
        material_id=mat_3d.id,
        quantity_pieces=1,
        width_mm=100,
        length_m=2,
    )
    db.add(line)
    db.flush()

    warnings = film_warnings(db, line)
    assert any("клеится ПЭТ 2Д, а в строке ПЭТ 3Д" in w for w in warnings)


def test_lamis_is_all_but_pet_and_pp():
    from types import SimpleNamespace as N
    from app.services.film_check import is_lamis_film
    assert is_lamis_film(N(name="ПВХ"), N(collection=None))
    assert is_lamis_film(N(name="Экошпон"), N(collection=None))
    assert not is_lamis_film(N(name="ПЭТ 3Д"), N(collection=None))
    assert not is_lamis_film(N(name="ПЭТ 2Д"), N(collection=None))
    assert not is_lamis_film(N(name="Полипропилен"), N(collection=None))
    assert not is_lamis_film(N(name="Неизвестно"), N(collection=None))
    assert is_lamis_film(N(name="ПЭТ 3Д"), N(collection="Ламис"))


def test_color_tokens_order_and_tf_hyphen():
    from app.services.sku_matching import color_tokens

    assert color_tokens("TF-53 Бьянко") == color_tokens("ПВХ Бьянко TF53")
    assert color_tokens("Бьянко") != color_tokens("Бьянко TF53")
    assert color_tokens("ПЭТ Бежевый (cream silk)") == color_tokens("Бежевый")
