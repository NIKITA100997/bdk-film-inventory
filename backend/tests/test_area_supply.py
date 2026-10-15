from app.services.area_supply import FILM, MATERIAL, PF, ItemInfo, measurable


def test_area_stock_kept_for_film_and_pf_only():
    assert measurable(ItemInfo(1, FILM, "ПВХ Капучино 0.1 мм", "м²", group=(1, 2, 3)))
    assert measurable(ItemInfo(2, PF, "Поперечная", "шт", part_id=5))
    assert not measurable(ItemInfo(3, PF, "п/ф без детали", "шт"))
    assert not measurable(ItemInfo(4, MATERIAL, "Клей", "кг"))
