"""Выгрузка счёта из 1С (16.10): .xls/.xlsx с колонками «Номенклатура» и
«Количество», имя файла — номер счёта («309-СКУ(М).xls»). Превращаем в
строки «наименование<TAB>кол-во» — тот же текст, что вставляют вручную в
окно «Из счёта 1С или графика», дальше обычный разбор по шаблону типа."""

import io
import re

import xlrd

_NAME_HEADERS = ("номенклатура", "наименование", "товар", "товары (работы, услуги)")
_QTY_HEADERS = ("количество", "кол-во", "кол.")
_COPY_SUFFIX_RE = re.compile(r"\s+\(\d+\)$")  # «309-СКУ(М) (1).xls» — вторая загрузка браузером


_LAT2CYR = str.maketrans("ABCEHKMOPTXY", "АВСЕНКМОРТХУ")


def invoice_key(no: str | None) -> str:
    """Один счёт — один заказ клиента (20.10): «1029-ЛД», «1029-лд(М)»,
    «№ 1029-ЛД» — один ключ «1029ЛД». Без «№», пробелов, дефисов, пометок в скобках
    в конце, регистра; латиница, похожая на кириллицу, — кириллицей."""
    s = (no or "").upper().replace("№", "")
    s = re.sub(r"(\s*\([^)]*\))+\s*$", "", s)  # «(М)» и подобные пометки в конце
    # без пробелов и дефисов: «1125ЛД» = «1125-ЛД» = «1836 - АТ»
    return re.sub(r"[\s\-–—]+", "", s).translate(_LAT2CYR)


def invoice_no_from_filename(filename: str) -> str:
    stem = re.sub(r"\.(xlsx?|xls)$", "", (filename or "").strip().replace("\\", "/").split("/")[-1], flags=re.I)
    return _COPY_SUFFIX_RE.sub("", stem).strip()


def _rows(data: bytes, filename: str) -> list[list[object]]:
    if (filename or "").lower().endswith(".xlsx") or data[:2] == b"PK":
        from openpyxl import load_workbook

        ws = load_workbook(io.BytesIO(data), read_only=True, data_only=True).worksheets[0]
        return [list(r) for r in ws.iter_rows(values_only=True)]
    sh = xlrd.open_workbook(file_contents=data).sheet_by_index(0)
    return [sh.row_values(i) for i in range(sh.nrows)]


def _qty(v: object) -> int | None:
    if v is None or v == "":
        return None
    try:
        q = float(str(v).replace(",", ".").replace("\xa0", "").replace(" ", ""))
    except ValueError:
        return None
    return int(q) if q > 0 and q == int(q) else None


def read_invoice(data: bytes, filename: str) -> tuple[list[tuple[str, int]], list[str]]:
    """Строки счёта (наименование, кол-во) и замечания. Шапку ищем по
    названиям колонок; «Итого» и пустые строки пропускаем."""
    try:
        rows = _rows(data, filename)
    except Exception as e:  # noqa: BLE001 — любой битый файл → понятная ошибка
        raise ValueError("Не удалось прочитать файл — нужна выгрузка счёта из 1С в Excel (.xls или .xlsx)") from e
    i_name = i_qty = None
    start = 0
    for n, r in enumerate(rows):
        cells = [str(c or "").strip().lower() for c in r]
        names = [i for i, c in enumerate(cells) if c in _NAME_HEADERS]
        qtys = [i for i, c in enumerate(cells) if c in _QTY_HEADERS]
        if names and qtys:
            i_name, i_qty, start = names[0], qtys[0], n + 1
            break
    if i_name is None:
        raise ValueError("В файле нет колонок «Номенклатура» и «Количество»")
    out: list[tuple[str, int]] = []
    problems: list[str] = []
    for n, r in enumerate(rows[start:], start=start + 1):
        name = " ".join(str(r[i_name] if i_name < len(r) and r[i_name] is not None else "").split())
        if not name or name.lower().startswith("итого"):
            continue
        q = _qty(r[i_qty] if i_qty < len(r) else None)
        if q is None:
            problems.append(f"Строка {n}: «{name}» — количество не целое число")
            continue
        out.append((name, q))
    if not out and not problems:
        problems.append("В счёте нет строк с позициями")
    return out, problems
