from app.services.film_check import pet_of_material


def test_pet_of_material():
    assert pet_of_material("ПЭТ 3Д") == "3d"
    assert pet_of_material("ПЭТ 2Д") == "2d"
    assert pet_of_material("пэт 3д") == "3d"
    assert pet_of_material("ПВХ") is None
    assert pet_of_material("Полипропилен") is None
    assert pet_of_material(None) is None
