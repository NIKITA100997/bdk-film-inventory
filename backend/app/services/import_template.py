"""Шаблон импорта графика у типа изделия (03.10) — как строки вставленного
из Excel графика становятся значениями свойств позиции. Раньше разбор был
зашит под щитовую дверь (колонки по порядку, «стекло»/«молдинг»/«защёлка»
регулярками в коде); теперь это настройка типа — другой вид дверей
заводится шаблоном, без программиста.

Шаблон (ItemType.import_template, JSON):

  columns — колонки графика по порядку:
    {"title": "Дата отгрузки", "role": "ship_date"}
    {"title": "№ счёта",       "role": "invoice"}
    {"title": "Кол-во дверей", "role": "qty"}
    {"title": "Наименование",  "role": "name"}
    {"title": "Серия",  "role": "property", "code": "серия"}
    {"title": "Размер", "role": "size", "codes": ["ширина", "высота"]}  — «800х2000»
    {"title": "Цвет",   "role": "property", "code": "цвет", "from_name": true}
        from_name — цвет из наименования после « - » (если там есть)
    {"title": "...",    "role": "skip"}

  defaults — значение по умолчанию из параметра выбранного варианта:
    {"code": "кромка", "from": "серия.кромка", "fallback": "abs"}

  rules — признаки из текста наименования (или уже найденного свойства —
  "source"), по порядку, более поздний совпавший перекрывает раньший:
    {"code": "молдинг", "pattern": "молдинг|\\(м\\d"}            — да/нет
    {"code": "стекло", "pattern": "стекло\\s+([^()]+)", "capture": 1}  — найденный текст
    {"code": "кромка", "source": "цвет_кромки", "pattern": "^(black|silver)$", "value": "aluminum"}
    "take": "last" — брать последнее совпадение в тексте.
  Свойство-флажок без совпадения — «нет», текст — пусто.
"""

import re
from dataclasses import dataclass, field
from datetime import date

ROLES = {
    "ship_date": "Дата отгрузки",
    "invoice": "№ счёта",
    "qty": "Количество",
    "name": "Наименование",
    "property": "Свойство",
    "size": "Размер (ширина × высота)",
    "skip": "Пропустить",
}

_SIZE_RE = re.compile(r"^\s*(\d{2,4})\s*[хxX×*Х]\s*(\d{3,4})\s*$")
_LATIN_TO_CYR = str.maketrans({"A": "А", "B": "В", "E": "Е", "H": "Н", "O": "О", "X": "Х"})


def option_key(text: str) -> str:
    """Ключ сопоставления текста графика с вариантом списка: «В-10.2» → то же,
    что «В-10» (модификация .1/.2), латиница → кириллица, без пробелов и
    дефисов: «Н-1 ВО» = «Н1 ВО»."""
    s = (text or "").strip().upper().translate(_LATIN_TO_CYR)
    s = re.sub(r"\.\d+$", "", s)
    return re.sub(r"[\s\-]", "", s)


def parse_size(text: str) -> tuple[int, int] | None:
    m = _SIZE_RE.match(text or "")
    return (int(m.group(1)), int(m.group(2))) if m else None


def parse_date(text: str) -> date | None:
    m = re.match(r"^\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s*$", text or "")
    if not m:
        return None
    day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if year < 100:
        year += 2000
    try:
        return date(year, month, day)
    except ValueError:
        return None


def color_from_name(name_text: str, color_text: str) -> str:
    """Цвет двери из наименования: «В-10.2 (…) 800х2000 - ПЭТ Бежевый (cream
    silk) кромка черная ABS 2мм» → «ПЭТ Бежевый (cream silk)». Не разобрали —
    колонка цвета."""
    tail = name_text.split(" - ", 1)[1] if " - " in name_text else ""
    tail = re.split(r"\s+кромка\b|\s+\(стекло|\s+\(Защелка|\s+\(защелка", tail, maxsplit=1)[0]
    # Скобки с фурнитурой — не цвет: «(PL410 + петли AGB Eclipse 3.0)».
    tail = re.sub(r"\((?=[^)]*(?:петл|PL\d|AGB|защел|стекл))[^)]*\)", " ", tail, flags=re.I)
    return " ".join(tail.split()) or " ".join((color_text or "").split())


@dataclass
class TemplateRow:
    line_no: int
    cells: list[str]
    ship_date: date | None = None
    invoice_no: str = ""
    qty: int = 0
    name_text: str = ""


@dataclass
class Template:
    columns: list[dict] = field(default_factory=list)
    defaults: list[dict] = field(default_factory=list)
    rules: list[dict] = field(default_factory=list)

    @classmethod
    def of(cls, raw: dict | None) -> "Template | None":
        if not raw or not raw.get("columns"):
            return None
        return cls(columns=list(raw.get("columns") or []), defaults=list(raw.get("defaults") or []),
                   rules=list(raw.get("rules") or []))

    def index(self, role: str) -> int | None:
        return next((i for i, c in enumerate(self.columns) if c.get("role") == role), None)

    def cell(self, row: TemplateRow, i: int | None) -> str:
        return row.cells[i] if i is not None and i < len(row.cells) else ""

    def column_text(self, row: TemplateRow, code: str) -> str:
        """Текст колонки свойства (или размера, где это свойство)."""
        for i, c in enumerate(self.columns):
            if (c.get("role") == "property" and c.get("code") == code) or (c.get("role") == "size" and code in (c.get("codes") or [])):
                return self.cell(row, i)
        return ""

    def color_column(self) -> dict | None:
        return next((c for c in self.columns if c.get("role") == "property" and c.get("from_name")), None)

    def color_text(self, row: TemplateRow, color_code: str) -> str:
        col = next((c for c in self.columns if c.get("role") == "property" and c.get("code") == color_code), None)
        if col is None:
            return ""
        raw = self.column_text(row, color_code)
        return color_from_name(row.name_text, raw) if col.get("from_name") else " ".join(raw.split())


def validate(tpl_raw: dict, type_) -> list[str]:
    """Ошибки шаблона против свойств типа — до сохранения."""
    errors: list[str] = []
    props = {p.code: p for p in type_.properties}
    cols = tpl_raw.get("columns") or []
    if not cols:
        return ["Нет ни одной колонки"]
    roles = [c.get("role") for c in cols]
    for r in roles:
        if r not in ROLES:
            errors.append(f"Неизвестная роль колонки: {r}")
    for need in ("qty", "name"):
        if roles.count(need) != 1:
            errors.append(f"Нужна ровно одна колонка «{ROLES[need]}»")
    for r in ("ship_date", "invoice"):
        if roles.count(r) > 1:
            errors.append(f"Колонка «{ROLES[r]}» — не больше одной")
    seen: set[str] = set()
    for c in cols:
        codes = [c.get("code")] if c.get("role") == "property" else (c.get("codes") or []) if c.get("role") == "size" else []
        if c.get("role") == "size" and len(codes) != 2:
            errors.append("У колонки размера — два свойства: ширина и высота")
        for code in codes:
            p = props.get(code)
            if p is None:
                errors.append(f"Колонка «{c.get('title') or ''}»: у типа нет свойства «{code}»")
            elif c.get("role") == "size" and p.value_type != "number":
                errors.append(f"Размер: свойство «{p.name}» должно быть числом")
            if code in seen:
                errors.append(f"Свойство «{code}» взято из двух колонок")
            seen.add(code)
    for d in tpl_raw.get("defaults") or []:
        if d.get("code") not in props:
            errors.append(f"По умолчанию: у типа нет свойства «{d.get('code')}»")
        src = (d.get("from") or "").split(".")[0]
        if d.get("from") and src not in props:
            errors.append(f"По умолчанию «{d.get('code')}»: у типа нет свойства «{src}»")
    for i, r in enumerate(tpl_raw.get("rules") or [], 1):
        p = props.get(r.get("code"))
        if p is None:
            errors.append(f"Правило {i}: у типа нет свойства «{r.get('code')}»")
            continue
        if r.get("source") and r["source"] not in props:
            errors.append(f"Правило {i}: у типа нет свойства «{r['source']}»")
        try:
            rx = re.compile(r.get("pattern") or "", re.IGNORECASE)
        except re.error as e:
            errors.append(f"Правило {i} («{p.name}»): шаблон не читается — {e}")
            continue
        if not r.get("pattern"):
            errors.append(f"Правило {i} («{p.name}»): пустой шаблон")
        if r.get("capture") and rx.groups < int(r["capture"]):
            errors.append(f"Правило {i} («{p.name}»): в шаблоне нет группы ( ) для найденного текста")
        if p.value_type == "list" and not r.get("capture"):
            if r.get("value") is None:
                errors.append(f"Правило {i} («{p.name}»): укажите вариант")
            elif not any(o.value == r.get("value") for o in p.options):
                errors.append(f"Правило {i}: варианта «{r.get('value')}» нет у свойства «{p.name}»")
    return errors


def parse_rows(text: str, tpl: Template) -> tuple[list[TemplateRow], list[str]]:
    """Строки вставленного графика по колонкам шаблона. Шапку (тексты
    совпадают с названиями колонок), пустые строки и заглушки шаблона
    (#VALUE!) пропускаем молча; прочие непонятные — в ошибки с номером."""
    rows: list[TemplateRow] = []
    errors: list[str] = []
    n = len(tpl.columns)
    i_qty, i_name, i_ship, i_inv = tpl.index("qty"), tpl.index("name"), tpl.index("ship_date"), tpl.index("invoice")
    titles = [(c.get("title") or "").strip().lower() for c in tpl.columns]
    data_cols = [i for i, c in enumerate(tpl.columns) if c.get("role") in ("property", "size")]
    for no, raw in enumerate(text.splitlines(), 1):
        cells = [c.strip() for c in raw.split("\t")]
        if not any(cells):
            continue
        cells += [""] * max(0, n - len(cells))
        if any(cells[i].startswith("#") for i in data_cols):
            continue
        if sum(1 for i, t in enumerate(titles) if t and cells[i].lower() == t) >= 2:
            continue
        row = TemplateRow(line_no=no, cells=cells[:n])
        row.name_text = tpl.cell(row, i_name)
        if not row.name_text:
            errors.append(f"Строка {no}: нет наименования")
            continue
        qty = re.sub(r"\s", "", tpl.cell(row, i_qty))
        if not qty.isdigit() or int(qty) <= 0:
            errors.append(f"Строка {no}: не число в «{tpl.columns[i_qty].get('title') or 'Количество'}» — «{tpl.cell(row, i_qty)}»")
            continue
        row.qty = int(qty)
        row.ship_date = parse_date(tpl.cell(row, i_ship))
        row.invoice_no = tpl.cell(row, i_inv)
        rows.append(row)
    return rows, errors


def match_option(prop, text: str):
    opts = [o for o in prop.options if getattr(o, "is_active", True)]
    t = " ".join((text or "").split()).lower()
    hit = next((o for o in opts if o.value.lower() == t or (getattr(o, "label", None) or "").lower() == t), None)
    if hit is None:
        key = option_key(text)
        hit = next((o for o in opts if option_key(o.value) == key), None)
    return hit


def apply_rules(tpl: Template, props: dict, values_by_code: dict[str, object], name_text: str) -> list[str]:
    """По умолчанию и правила: values_by_code (код → значение; у списка —
    значение варианта, ещё не id) дополняется. Возвращает ошибки."""
    for d in tpl.defaults:
        code = d.get("code")
        if code in values_by_code:
            continue
        v = None
        src, _, param = (d.get("from") or "").partition(".")
        opt = values_by_code.get(f"__option__{src}")
        if opt is not None and param:
            v = (getattr(opt, "params", None) or {}).get(param)
        values_by_code[code] = v if v not in (None, "") else d.get("fallback")
    for r in tpl.rules:
        code = r.get("code")
        p = props.get(code)
        if p is None:
            continue
        text = name_text if not r.get("source") else str(values_by_code.get(r["source"]) or "")
        rx = re.compile(r.get("pattern") or "", re.IGNORECASE)
        matches = list(rx.finditer(text))
        if not matches:
            continue
        m = matches[-1] if r.get("take") == "last" else matches[0]
        if r.get("capture"):
            v: object = " ".join((m.group(int(r["capture"])) or "").split())
        elif r.get("value") is not None:
            v = r["value"]
        else:
            v = True
        values_by_code[code] = v
    for r in tpl.rules:
        p = props.get(r.get("code"))
        if p is not None and p.code not in values_by_code:
            values_by_code[p.code] = False if p.value_type == "bool" else ("" if p.value_type == "text" else None)
    return []
