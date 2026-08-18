import pytest

from app.services.naryad_import import parse_naryad_grid, parse_pogonazh_grid


def _row(width: int, cols: dict[int, object]) -> list:
    """Строит строку сетки нужной ширины по {номер_колонки: значение} —
    реальные печатные формы этой ERP держат заголовки/данные в
    разреженных, не подряд идущих колонках (см. реальный образец), тест
    должен это пережить, а не полагаться на компактные строки."""
    row = [""] * width
    for idx, val in cols.items():
        row[idx] = val
    return row


# Структурно верная (разреженные колонки, как в реальном файле), но
# уменьшенная копия образца печатной формы
# ("ПечатнаяФорма_ПереченьДеталейСтолярныхИзделий...xls") — раздел про
# загрузку наряд-заказа. Колонки заголовка/данных здесь намеренно не
# совпадают по номеру с "Деталь", чтобы проверить, что парсер ищет их по
# тексту заголовка, а не по фиксированному номеру.
SAMPLE_GRID = [
    _row(2, {1: "#ОттискКтоКогда#"}),
    _row(48, {17: "М-13 (Капучино)", 46: 234.0}),
    [],
    _row(21, {19: "Модель"}),
    [],
    [],
    _row(2, {1: "#ОттискКтоКогда#"}),
    _row(2, {1: "РАСКЛАДКА"}),
    [],
    _row(63, {1: "Деталь", 38: "Толщ.", 43: "Ширина", 49: "Длина", 55: "Видимая\nчасть", 62: "Кол-во"}),
    [],
    _row(2, {1: "Поперечная (МежКомн)"}),
    _row(63, {1: "Поперечная (МежКомн) 30х110х504 (Капучино) ПАЗ-11", 38: 30.0, 43: 110.0, 49: 504.0, 55: 484.0, 62: 4.0}),
    [],
    _row(2, {1: "Стоевая (МежКомн)"}),
    _row(63, {1: "Стоевая (МежКомн) 36х108х2000 (Капучино) ПАЗ-11", 38: 36.0, 43: 108.0, 49: 2000.0, 62: 12.0}),
    [],
    _row(2, {1: "#ОттискКтоКогда#"}),
    _row(2, {1: 'Ведомость по деталям на заказ: "Стоевая на МежКом дверь"'}),
]


class TestParseNaryadGrid:
    def test_extracts_suggested_name_with_order_number_and_model(self):
        result = parse_naryad_grid(SAMPLE_GRID)
        assert result.suggested_name == "Заказ №234 — М-13 (Капучино)"

    def test_extracts_all_detail_lines(self):
        result = parse_naryad_grid(SAMPLE_GRID)
        assert len(result.lines) == 2
        first, second = result.lines
        assert first.part_name == "Поперечная (МежКомн) 30х110х504 (Капучино) ПАЗ-11"
        assert first.width_mm == 110.0
        assert first.length_m == 0.504
        assert first.quantity_pieces == 4.0
        assert second.part_name == "Стоевая (МежКомн) 36х108х2000 (Капучино) ПАЗ-11"
        assert second.width_mm == 108.0
        assert second.length_m == 2.0
        assert second.quantity_pieces == 12.0

    def test_stops_before_vedomost_section(self):
        # Строка "Ведомость по деталям..." идёт после ещё одного маркера
        # "#ОттискКтоКогда#" — обе не должны попасть в разбор как детали,
        # и данные из этого раздела не должны задваивать уже прочитанные.
        result = parse_naryad_grid(SAMPLE_GRID)
        assert all("Ведомость" not in l.part_name for l in result.lines)

    def test_group_header_rows_are_not_treated_as_details(self):
        # "Поперечная (МежКомн)"/"Стоевая (МежКомн)" сами по себе — заголовки
        # групп без ширины/длины/кол-ва, не должны попасть как отдельные
        # (некорректные) строки.
        result = parse_naryad_grid(SAMPLE_GRID)
        names = [l.part_name for l in result.lines]
        assert "Поперечная (МежКомн)" not in names
        assert "Стоевая (МежКомн)" not in names

    def test_missing_raskladka_raises(self):
        with pytest.raises(ValueError, match="РАСКЛАДКА"):
            parse_naryad_grid([["", "Просто какой-то другой файл"]])

    def test_raskladka_without_header_row_raises(self):
        with pytest.raises(ValueError, match="Деталь"):
            parse_naryad_grid([["", "РАСКЛАДКА"], ["", "тут нет нужных заголовков"]])

    def test_no_order_number_falls_back_to_generic_name(self):
        grid = [["", "РАСКЛАДКА"], ["", "Деталь", "Ширина", "Длина", "Кол-во"], ["", "Штрипс", 100.0, 500.0, 3.0]]
        result = parse_naryad_grid(grid)
        assert result.suggested_name == "Наряд-заказ"
        assert len(result.lines) == 1

    def test_zero_or_negative_quantity_rows_are_skipped(self):
        grid = [
            ["", "РАСКЛАДКА"],
            ["", "Деталь", "Ширина", "Длина", "Кол-во"],
            ["", "Пустая строка", 100.0, 500.0, 0.0],
            ["", "Валидная строка", 100.0, 500.0, 2.0],
        ]
        result = parse_naryad_grid(grid)
        assert len(result.lines) == 1
        assert result.lines[0].part_name == "Валидная строка"


# Уменьшенная копия реального образца погонажного наряда
# ("ПечатнаяФорма_...ДоборныйПогонаж...xls") — раздел про размеры,
# зашитые в текст названия, а не в отдельные колонки.
POGONAZH_GRID = [
    _row(2, {1: "#ОттискКтоКогда#"}),
    _row(47, {1: "ДОБОРНЫЙ ПОГОНАЖ", 46: 1546.0}),
    [],
    _row(61, {1: "Деталь", 40: "Кол-во в упак.", 50: "Кол-во ПЛАН", 60: "Кол-во ФАКТ"}),
    _row(61, {1: "Добор телескоп 10х100х2070 (ПЭТ Белый)", 40: 5.0, 50: 10.0}),
    _row(61, {1: "Добор телескоп 10х150х2070 (ПЭТ Белый)", 40: 5.0, 50: 5.0}),
    _row(61, {1: "Коробка с упл. (белый УК-6) телескоп МДФ 32х75х2070 (ПЭТ Белый)", 40: 4.0, 50: 16.0}),
    _row(61, {1: "Наличник телескоп 8х70х2150 (ПЭТ Белый)", 40: 5.0, 50: 30.0}),
]


class TestParsePogonazhGrid:
    def test_extracts_suggested_name(self):
        result = parse_pogonazh_grid(POGONAZH_GRID)
        assert result.suggested_name == "Заказ №1546 — ДОБОРНЫЙ ПОГОНАЖ"

    def test_extracts_all_lines(self):
        result = parse_pogonazh_grid(POGONAZH_GRID)
        assert len(result.lines) == 4

    def test_dimensions_parsed_from_name_text(self):
        result = parse_pogonazh_grid(POGONAZH_GRID)
        dobor = result.lines[0]
        assert dobor.part_name == "Добор телескоп 10х100х2070 (ПЭТ Белый)"
        assert dobor.width_mm == 100.0
        assert dobor.length_m == 2.07
        assert dobor.quantity_pieces == 10.0
        assert dobor.strip_width_mm is None  # не короб — считается через calc_default_strip_width

    def test_uses_kolvo_plan_not_kolvo_v_upak(self):
        # "Кол-во в упак."=5, "Кол-во ПЛАН"=10 — должно попасть именно 10,
        # не количество в упаковке.
        result = parse_pogonazh_grid(POGONAZH_GRID)
        assert result.lines[0].quantity_pieces == 10.0

    def test_korob_gets_strip_width_from_profile_lookup(self):
        result = parse_pogonazh_grid(POGONAZH_GRID)
        korob = next(l for l in result.lines if "Коробка" in l.part_name)
        assert korob.width_mm == 75.0
        assert korob.strip_width_mm == 120.0  # профиль (75, 32) -> 120мм

    def test_missing_kolvo_plan_column_raises(self):
        with pytest.raises(ValueError, match="Кол-во ПЛАН"):
            parse_pogonazh_grid([["", "Деталь", "Кол-во в упак."], ["", "Что-то", 5.0]])

    def test_rows_without_parseable_dimensions_in_name_are_skipped(self):
        grid = [
            ["", "Деталь", "", "", "", "", "", "", "", "", "Кол-во ПЛАН"],
            ["", "Название без размеров в тексте", "", "", "", "", "", "", "", "", 5.0],
            ["", "Добор телескоп 10х100х2070", "", "", "", "", "", "", "", "", 10.0],
        ]
        result = parse_pogonazh_grid(grid)
        assert len(result.lines) == 1
        assert result.lines[0].part_name == "Добор телескоп 10х100х2070"
