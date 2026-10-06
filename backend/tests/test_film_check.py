from app.services.film_check import pet_of_material


def test_pet_of_material():
    assert pet_of_material("ПЭТ 3Д") == "3d"
    assert pet_of_material("ПЭТ 2Д") == "2d"
    assert pet_of_material("пэт 3д") == "3d"
    assert pet_of_material("ПВХ") is None
    assert pet_of_material("Полипропилен") is None
    assert pet_of_material(None) is None


def test_lamis_is_any_pvc():
    from types import SimpleNamespace as N
    from app.services.film_check import is_lamis_film
    assert is_lamis_film(N(name="ПВХ"), N(collection=None))
    assert not is_lamis_film(N(name="ПЭТ 3Д"), N(collection=None))
    assert is_lamis_film(N(name="ПЭТ 3Д"), N(collection="Ламис"))
