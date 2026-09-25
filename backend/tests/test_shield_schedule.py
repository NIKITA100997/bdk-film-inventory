from datetime import date

from app.services.shield_schedule import parse_line_features, parse_pasted_schedule, parse_size, series_key


class TestSeriesKey:
    def test_variant_suffix_maps_to_base_series(self):
        assert series_key("В-10.2") == series_key("В-10")

    def test_hyphen_and_spaces_ignored(self):
        assert series_key("Н-1 ВО") == series_key("Н1 ВО")

    def test_latin_lookalikes_match_cyrillic(self):
        assert series_key("B-13") == series_key("В-13")

    def test_film_variant_kept_distinct(self):
        assert series_key("В-5/Ф3") != series_key("В-5")

    def test_different_series_differ(self):
        assert series_key("В-1") != series_key("В-10")


class TestParseSize:
    def test_cyrillic_x(self):
        assert parse_size("800х2000") == (800, 2000)

    def test_latin_x_and_spaces(self):
        assert parse_size(" 600 x 2030 ") == (600, 2030)

    def test_narrow_door(self):
        assert parse_size("300х2000") == (300, 2000)

    def test_garbage(self):
        assert parse_size("#VALUE!") is None


class TestLineFeatures:
    def test_abs_edge_with_moulding_groove(self):
        f = parse_line_features(
            "В-10.2 (м5х3 кромка 4х) 800х2000 - ПЭТ Бежевый (cream silk) кромка черная ABS 2мм", "abs"
        )
        assert f.edge_type == "abs"
        assert f.has_moulding and not f.has_glass and not f.needs_lock_milling

    def test_aluminum_with_moulding_and_latch(self):
        f = parse_line_features(
            "Е-14.2 (м5х3 кромка 4х под ПЭТ) 600х2000 - ПЭТ Светло-серый (gray silk) (Защелка Border room) "
            "кромка Black Молдинг 5х3 мм черный",
            "aluminum",
        )
        assert f.edge_type == "aluminum"
        assert f.has_moulding and f.needs_lock_milling

    def test_b_series_with_aluminum_profile_overrides_default(self):
        f = parse_line_features(
            "В-16.2 (м5х3 + м3х3 кромка 4х под ПЭТ) 800х2000 - ПЭТ Темно-серый (stormy silk) кромка Black "
            "Молдинг 5х3 мм черный",
            "abs",
        )
        assert f.edge_type == "aluminum"

    def test_sides_phrase_does_not_decide_edge(self):
        f = parse_line_features(
            "Е-5 кромка с 4-х сторон 700х2300 - ПЭТ Светло-серый (gray silk) (Защелка Border room) кромка Black",
            "aluminum",
        )
        assert f.edge_type == "aluminum"
        assert f.needs_lock_milling and not f.has_moulding

    def test_pet_edge_banding(self):
        f = parse_line_features(
            "В-5 кромка с 4-х сторон 800х2000 - ПЭТ Бежевый (cream silk) кромка ПЭТ Бежевая 1мм", "abs"
        )
        assert f.edge_type == "abs"

    def test_no_final_edge_falls_back_to_series(self):
        f = parse_line_features("В-11 кромка с 4-х сторон 550х1950 - Полипропилен Аляска (стекло Сатин)", "abs")
        assert f.edge_type == "abs" and f.has_glass

    def test_glass_and_silver_profile(self):
        f = parse_line_features(
            "А-1 700х2000 - Bolton Oak (стекло Зеркало БРОНЗА матовая) (под PL410) кромка Silver", "aluminum"
        )
        assert f.edge_type == "aluminum"
        assert f.has_glass and f.needs_lock_milling

    def test_edge_followed_by_hand(self):
        f = parse_line_features(
            "Н-1 ВО 600х1750 - Полипропилен INVISIBLE Белый грунтовочный (PL410 + петли AGB Eclipse 3.0) "
            "кромка Black (ЛЕВАЯ)",
            "aluminum",
        )
        assert f.edge_type == "aluminum"


class TestPastedSchedule:
    HEADER = "Дата отгрузки\t№ счёта\tСерия\tРазмер\tЦвет\tНаименование\tКол-во дверей"

    def test_parses_rows_and_skips_header_and_template_junk(self):
        text = "\n".join(
            [
                self.HEADER,
                "\t1726-ВД\tВ-10.2\t800х2000\tПЭТ Бежевый\tВ-10.2 (м5х3 кромка 4х) 800х2000 - ПЭТ Бежевый\t1",
                "25.09.2026\t1589-ДВ\tЕ-14.2\t600х2000\tПЭТ Светло-серый\tЕ-14.2 600х2000 - ПЭТ\t6",
                "\t\t#VALUE!\t#VALUE!\t#VALUE!",
                "",
            ]
        )
        rows, errors = parse_pasted_schedule(text)
        assert errors == []
        assert [r.series_text for r in rows] == ["В-10.2", "Е-14.2"]
        assert rows[0].ship_date is None and rows[0].doors_qty == 1
        assert rows[1].ship_date == date(2026, 9, 25) and rows[1].doors_qty == 6

    def test_bad_quantity_reported_with_line_number(self):
        rows, errors = parse_pasted_schedule("\t1\tВ-5\t800х2000\tБелый\tВ-5 800х2000\tмного")
        assert rows == []
        assert errors and errors[0].startswith("Строка 1")


def test_glass_kind_and_edge_text_from_1c_name():
    f = parse_line_features(
        "В-9 кромка с 4-х сторон 600х2000 - ПЭТ Светло-серый (gray silk) (стекло Зеркало ГРАФИТ) кромка черная ABS 2мм", "abs"
    )
    assert (f.glass, f.edge_text, f.edge_type) == ("Зеркало ГРАФИТ", "черная ABS 2мм", "abs")


def test_glass_without_kind():
    f = parse_line_features("В-16.2 со стеклом кромка Black", "abs")
    assert (f.glass, f.edge_text, f.edge_type) == ("есть", "Black", "aluminum")


def test_no_glass():
    assert parse_line_features("В-5 600х2000 Эмалит белый", "abs").glass == ""


def test_edge_after_sides_phrase_without_brackets():
    # «кромка с 4-х сторон …» без скобок не должна поглощать саму кромку двери.
    f = parse_line_features("В-5 кромка с 4-х сторон 600х2000 - Эмалит белый кромка черная ABS", "aluminum")
    assert (f.edge_text, f.edge_type) == ("черная ABS", "abs")
