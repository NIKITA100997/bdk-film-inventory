"""Разбор графика щитовых дверей — шаблоном импорта типа (миграция
e5b7d9f1a3c4 ставит его щитовой двери): те же случаи, что раньше
проверяли зашитый в код разбор."""

import importlib.util
from datetime import date
from pathlib import Path
from types import SimpleNamespace as NS

from app.services.import_template import Template, apply_rules, option_key, parse_rows, parse_size, validate

_MIG = next((Path(__file__).parents[1] / "alembic" / "versions").glob("e5b7d9f1a3c4_*.py"))
_spec = importlib.util.spec_from_file_location("shield_tpl_migration", _MIG)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
TPL = Template.of(_mod.SHIELD_TEMPLATE)


def _props():
    def prop(code, vt, options=()):
        return NS(id=code, code=code, name=code.capitalize(), value_type=vt, options=list(options), is_required=True)

    opt = lambda v: NS(id=v, value=v, label=None, is_active=True, params={})  # noqa: E731
    return {
        p.code: p
        for p in [
            prop("серия", "list"),
            prop("ширина", "number"),
            prop("высота", "number"),
            prop("цвет", "list"),
            prop("стекло", "text"),
            prop("молдинг", "bool"),
            prop("замок", "bool"),
            prop("кромка", "list", [opt("abs"), opt("aluminum")]),
            prop("цвет_кромки", "text"),
        ]
    }


def features(name: str, series_edge: str) -> dict:
    by_code = {"__option__серия": NS(params={"кромка": series_edge})}
    apply_rules(TPL, _props(), by_code, name)
    return by_code


def test_template_valid_for_shield_type():
    assert validate(_mod.SHIELD_TEMPLATE, NS(properties=list(_props().values()))) == []


class TestOptionKey:
    def test_variant_suffix_maps_to_base_series(self):
        assert option_key("В-10.2") == option_key("В-10")

    def test_hyphen_and_spaces_ignored(self):
        assert option_key("Н-1 ВО") == option_key("Н1 ВО")

    def test_latin_lookalikes_match_cyrillic(self):
        assert option_key("B-13") == option_key("В-13")

    def test_film_variant_kept_distinct(self):
        assert option_key("В-5/Ф3") != option_key("В-5")

    def test_different_series_differ(self):
        assert option_key("В-1") != option_key("В-10")


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
        f = features("В-10.2 (м5х3 кромка 4х) 800х2000 - ПЭТ Бежевый (cream silk) кромка черная ABS 2мм", "abs")
        assert f["кромка"] == "abs"
        assert f["молдинг"] and f["стекло"] == "" and not f["замок"]

    def test_aluminum_with_moulding_and_latch(self):
        f = features(
            "Е-14.2 (м5х3 кромка 4х под ПЭТ) 600х2000 - ПЭТ Светло-серый (gray silk) (Защелка Border room) "
            "кромка Black Молдинг 5х3 мм черный",
            "aluminum",
        )
        assert f["кромка"] == "aluminum"
        assert f["молдинг"] and f["замок"]

    def test_b_series_with_aluminum_profile_overrides_default(self):
        f = features(
            "В-16.2 (м5х3 + м3х3 кромка 4х под ПЭТ) 800х2000 - ПЭТ Темно-серый (stormy silk) кромка Black "
            "Молдинг 5х3 мм черный",
            "abs",
        )
        assert f["кромка"] == "aluminum"

    def test_sides_phrase_does_not_decide_edge(self):
        f = features("Е-5 кромка с 4-х сторон 700х2300 - ПЭТ Светло-серый (gray silk) (Защелка Border room) кромка Black", "aluminum")
        assert f["кромка"] == "aluminum"
        assert f["замок"] and not f["молдинг"]

    def test_pet_edge_banding(self):
        f = features("В-5 кромка с 4-х сторон 800х2000 - ПЭТ Бежевый (cream silk) кромка ПЭТ Бежевая 1мм", "abs")
        assert f["кромка"] == "abs"

    def test_no_final_edge_falls_back_to_series(self):
        f = features("В-11 кромка с 4-х сторон 550х1950 - Полипропилен Аляска (стекло Сатин)", "abs")
        assert f["кромка"] == "abs" and f["стекло"]

    def test_glass_and_silver_profile(self):
        f = features("А-1 700х2000 - Bolton Oak (стекло Зеркало БРОНЗА матовая) (под PL410) кромка Silver", "aluminum")
        assert f["кромка"] == "aluminum"
        assert f["стекло"] and f["замок"]

    def test_edge_followed_by_hand(self):
        f = features(
            "Н-1 ВО 600х1750 - Полипропилен INVISIBLE Белый грунтовочный (PL410 + петли AGB Eclipse 3.0) кромка Black (ЛЕВАЯ)",
            "aluminum",
        )
        assert f["кромка"] == "aluminum"

    def test_glass_kind_and_edge_text_from_1c_name(self):
        f = features(
            "В-9 кромка с 4-х сторон 600х2000 - ПЭТ Светло-серый (gray silk) (стекло Зеркало ГРАФИТ) кромка черная ABS 2мм", "abs"
        )
        assert (f["стекло"], f["цвет_кромки"], f["кромка"]) == ("Зеркало ГРАФИТ", "черная ABS 2мм", "abs")

    def test_glass_without_kind(self):
        f = features("В-16.2 со стеклом кромка Black", "abs")
        assert (f["стекло"], f["цвет_кромки"], f["кромка"]) == ("есть", "Black", "aluminum")

    def test_no_glass(self):
        assert features("В-5 600х2000 Эмалит белый", "abs")["стекло"] == ""

    def test_edge_after_sides_phrase_without_brackets(self):
        # «кромка с 4-х сторон …» без скобок не должна поглощать саму кромку двери.
        f = features("В-5 кромка с 4-х сторон 600х2000 - Эмалит белый кромка черная ABS", "aluminum")
        assert (f["цвет_кромки"], f["кромка"]) == ("черная ABS", "abs")

    def test_series_without_edge_param_uses_fallback(self):
        by_code = {"__option__серия": NS(params={})}
        apply_rules(TPL, _props(), by_code, "В-5 600х2000 Эмалит белый")
        assert by_code["кромка"] == "abs"


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
        rows, errors = parse_rows(text, TPL)
        assert errors == []
        assert [TPL.column_text(r, "серия") for r in rows] == ["В-10.2", "Е-14.2"]
        assert rows[0].ship_date is None and rows[0].qty == 1
        assert rows[1].ship_date == date(2026, 9, 25) and rows[1].qty == 6

    def test_bad_quantity_reported_with_line_number(self):
        rows, errors = parse_rows("\t1\tВ-5\t800х2000\tБелый\tВ-5 800х2000\tмного", TPL)
        assert rows == []
        assert errors and errors[0].startswith("Строка 1")


def test_validate_catches_unknown_property_and_bad_regex():
    bad = {
        "columns": [{"role": "name"}, {"role": "qty"}, {"role": "property", "code": "нет_такого"}],
        "rules": [{"code": "молдинг", "pattern": "("}],
    }
    errs = validate(bad, NS(properties=list(_props().values())))
    assert any("нет_такого" in e for e in errs) and any("не читается" in e for e in errs)


class TestPasteVariants:
    def test_copied_without_ship_date_column(self):
        # выделили строки с колонки «№ счёта» — без «Даты отгрузки»
        text = "1726-ВД\tВ-10.2\t800х2000\tПЭТ Бежевый\tВ-10.2 (м5х3 кромка 4х) 800х2000 - ПЭТ Бежевый\t1\n" \
               "1589-ДВ\tЕ-14.2\t600х2000\tПЭТ Светло-серый\tЕ-14.2 600х2000 - ПЭТ\t6"
        rows, errors = parse_rows(text, TPL)
        assert errors == []
        assert [(r.invoice_no, r.qty, TPL.column_text(r, "серия")) for r in rows] == [("1726-ВД", 1, "В-10.2"), ("1589-ДВ", 6, "Е-14.2")]

    def test_cell_with_line_break_inside(self):
        text = '\t1589-ДВ\tЕ-17.2\t600х2000\t"ПЭТ Светло-\nкоричневый"\tЕ-17.2 600х2000 - ПЭТ Светло-коричневый\t6\n' \
               "\t1781-АВ\tВ-13.2\t700х2000\tПЭТ Светло-серый\tВ-13.2 700х2000 - ПЭТ Светло-серый\t1"
        rows, errors = parse_rows(text, TPL)
        assert errors == []
        assert TPL.column_text(rows[0], "цвет") == "ПЭТ Светло- коричневый"
        assert [r.qty for r in rows] == [6, 1]

    def test_empty_quantity_still_an_error(self):
        rows, errors = parse_rows("\t1\tВ-5\t800х2000\tБелый\tВ-5 800х2000\t", TPL)
        assert rows == [] and errors and "не число" in errors[0]
