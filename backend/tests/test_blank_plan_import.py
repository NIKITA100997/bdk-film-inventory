from datetime import datetime

from app.services.blank_plan_import import find_blocks, normalize_part_name, parse_blank_plan_block


def _row(width: int, cols: dict[int, object]) -> list:
    """Тот же приём, что в test_naryad_import.py — реальные листы держат
    заголовки/данные в разреженных, не подряд идущих колонках, да ещё и
    с несколькими независимыми блоками бок о бок; тест должен это
    пережить, а не полагаться на компактные строки/номера колонок."""
    row = [""] * width
    for idx, val in cols.items():
        row[idx] = val
    return row


# Структурно верная (разреженные колонки, два блока бок о бок, разная
# раскладка между ними), но уменьшенная копия реального листа
# ("Заготовки межкомнатка.xlsx", лист "Лист40"). Объединённые ячейки
# "Номенклатура" здесь уже "развёрнуты" (одинаковое значение в
# нескольких строках подряд) — так их и отдаёт _resolve_merged до
# передачи сюда, сам parse_blank_plan_block объединений не знает.
SAMPLE_GRID = [
    _row(20, {1: datetime(2026, 1, 2)}),  # дата над блоком 1 (openpyxl отдаёт datetime) — используется как suggested_name
    _row(20, {1: "Номенклатура", 3: "Цвет", 7: "Заказ", 10: "Номенклатура", 16: "Заказ"}),
    _row(20, {1: "Заготовка Стоевая 36х108х2035 ПАЗ-11", 3: "Капучино", 7: 12}),
    _row(20, {1: "Заготовка Стоевая 36х108х2035 ПАЗ-11", 3: "Дуб золотой", 7: 5}),
    _row(20, {1: "Заготовка Стоевая 36х108х2035 ПАЗ-11", 3: "Белый", 7: 0}),  # Заказ=0 — пропустить
    _row(20, {1: "Номенклатура", 3: "Цвет", 7: "Заказ"}),  # повторный заголовок (разрыв страницы)
    _row(20, {1: "Заготовка Филёнка 10х220 ПАЗ-4", 3: "Венге", 7: 8}),
]


class TestFindBlocks:
    def test_finds_both_side_by_side_blocks_by_column_position(self):
        blocks = find_blocks(SAMPLE_GRID)
        assert [(b[1], b[2]) for b in blocks] == [(1, 9), (10, 19)]

    def test_uses_first_top_occurrence_as_header_row_ignoring_repeats(self):
        blocks = find_blocks(SAMPLE_GRID)
        header_row_idx, col_start, _ = blocks[0]
        assert header_row_idx == 1
        assert col_start == 1


class TestParseBlankPlanBlock:
    def test_extracts_lines_with_separate_color_column(self):
        block = parse_blank_plan_block(SAMPLE_GRID, header_row_idx=1, col_start=1, col_end=9, sheet_name="Лист1", block_index=0)
        assert [(l.part_name_raw, l.color_raw, l.quantity_pieces) for l in block.lines] == [
            ("Стоевая 36х108х2035 ПАЗ-11", "Капучино", 12.0),
            ("Стоевая 36х108х2035 ПАЗ-11", "Дуб золотой", 5.0),
            ("Филёнка 10х220 ПАЗ-4", "Венге", 8.0),
        ]

    def test_skips_rows_with_zero_order_quantity(self):
        block = parse_blank_plan_block(SAMPLE_GRID, header_row_idx=1, col_start=1, col_end=9, sheet_name="Лист1", block_index=0)
        assert all(l.color_raw != "Белый" for l in block.lines)

    def test_repeated_header_row_does_not_reset_or_break_parsing(self):
        block = parse_blank_plan_block(SAMPLE_GRID, header_row_idx=1, col_start=1, col_end=9, sheet_name="Лист1", block_index=0)
        assert len(block.lines) == 3  # включая строку после повторного заголовка

    def test_suggested_name_from_date_row_above_header(self):
        block = parse_blank_plan_block(SAMPLE_GRID, header_row_idx=1, col_start=1, col_end=9, sheet_name="Лист1", block_index=0)
        assert block.suggested_name == "Заготовки на 2026-01-02"

    def test_extracts_color_from_trailing_parenthesis_when_no_color_column(self):
        row = _row(20, {10: "Заготовка Стоевая (МежКомн) 36х108х2035 (Bolton Oak) ПАЗ-11", 16: 20})
        grid = [SAMPLE_GRID[1], row]
        block = parse_blank_plan_block(grid, header_row_idx=0, col_start=10, col_end=19, sheet_name="Лист1", block_index=1)
        assert len(block.lines) == 1
        assert block.lines[0].color_raw == "Bolton Oak"
        assert block.lines[0].part_name_raw == "Стоевая 36х108х2035 ПАЗ-11"

    def test_falls_back_to_sheet_and_index_when_no_title_row_found(self):
        grid = [SAMPLE_GRID[1], SAMPLE_GRID[2]]
        block = parse_blank_plan_block(grid, header_row_idx=0, col_start=1, col_end=9, sheet_name="Лист7", block_index=2)
        assert block.suggested_name == "Лист7 — блок 3"


class TestNormalizePartName:
    def test_strips_leading_zagotovka_word(self):
        assert normalize_part_name("Заготовка Стоевая 36х108х2035 ПАЗ-11") == "Стоевая 36х108х2035 ПАЗ-11"

    def test_strips_mezhkomn_marker_anywhere(self):
        assert normalize_part_name("Стоевая (МежКомн) 36х108х2035 ПАЗ-11") == "Стоевая 36х108х2035 ПАЗ-11"

    def test_collapses_double_spaces(self):
        assert normalize_part_name("Стоевая  36х108х2035  ПАЗ-11") == "Стоевая 36х108х2035 ПАЗ-11"
