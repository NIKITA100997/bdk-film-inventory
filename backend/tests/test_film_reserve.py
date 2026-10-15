from types import SimpleNamespace

from app.services.film_reserve import _roll_meters


def test_same_width_takes_strip_meters():
    assert _roll_meters(SimpleNamespace(width_mm=83), 83, 100, True) == 100


def test_wide_roll_is_cut_into_strips():
    # 1220 мм на штрипсы 300 — 4 в ширину: 100 м штрипса = 25 м рулона
    assert _roll_meters(SimpleNamespace(width_mm=1220), 300, 100, False) == 25


def test_roll_narrower_than_two_strips_counts_one():
    assert _roll_meters(SimpleNamespace(width_mm=500), 300, 40, False) == 40


def test_color_note_in_brackets_is_stripped():
    import re

    bare = re.sub(r"\s*\([^()]*\)\s*$", "", "ПЭТ Бежевый (cream silk)")
    assert bare == "ПЭТ Бежевый"


def test_wider_strip_within_tolerance_fits_report():
    from app.api.production import strip_width_fits

    assert strip_width_fits(140, 135, {135.0}, 10)  # Филадельфия Крем 140 под строку 135
    assert strip_width_fits(145, 135, {135.0}, 10)
    assert not strip_width_fits(146, 135, {135.0}, 10)
    assert not strip_width_fits(130, 135, {135.0}, 10)  # уже — нельзя
    assert not strip_width_fits(140, 135, {135.0}, 0)  # допуск выключен
    assert strip_width_fits(135, 135, {135.0}, 0)


def test_roll_mismatch_reason_names_both_films():
    from types import SimpleNamespace

    import app.api.production as prod
    from app.models.units import UnitStatus

    unit = SimpleNamespace(id=639, status=UnitStatus.VYDAN_UCHASTKU, production_task_line_id=1, width_mm=221,
                           material_sku=SimpleNamespace(material_id=1, color_id=15, thickness_id=15))
    src = SimpleNamespace(id=1, task_id=10, material_id=1, color_id=15, thickness_id=15)
    line = SimpleNamespace(id=2, task_id=10, material_id=1, color_id=76, thickness_id=20, part_name="Филенка (Панель) 8х207х1800")
    task = SimpleNamespace(area="okutka_tsargovykh")

    class DB:
        def get(self, model, key):
            return {("ProductionTaskLine", 1): src, ("ProductionTask", 10): task}.get((model.__name__, key))

    orig = prod._film_label
    prod._film_label = lambda db, m, c, t: {15: "ПВХ Ясень Ривьера Айс", 76: "ПВХ Капучино"}[c]
    try:
        msg = prod._roll_mismatch_reason(DB(), unit, line)
    finally:
        prod._film_label = orig
    assert "ПЛ-639" in msg and "Ясень Ривьера Айс" in msg and "Капучино" in msg
