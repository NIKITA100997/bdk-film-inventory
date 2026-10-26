"""Импорт графика запуска в заказ на производство (единая модель). Как
колонки и наименование строки становятся свойствами позиции — шаблон
импорта у типа изделия (services/import_template.py, 03.10; раньше —
зашито под щитовую дверь). Позиция находится или создаётся по типу,
строка графика — строкой заказа."""

import re
from dataclasses import dataclass, field

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.items import Item, ItemType
from app.models.production_orders import ORDER_DRAFT, ProductionOrder, ProductionOrderLine
from app.services import type_rules
from app.services.import_template import Template, TemplateRow, apply_rules, color_from_name, match_option, parse_rows, parse_size

_ROW_NOTES: list[str] = []  # пометки разбора текущей строки (новый цвет и т.п.)


@dataclass
class ImportRow:
    series: str
    size: str
    color: str
    name_text: str
    qty: int
    invoice_no: str
    ship_date: str | None
    item_name: str | None = None
    exists: bool = False
    item_id: int | None = None
    type_name: str | None = None
    errors: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    # несколько подходящих позиций (21.10): выбор в окне загрузки — [{id, name}]
    candidates: list[dict] = field(default_factory=list)
    # исполнение из строки (26.10): [{code, name, value, op}] — в строку заказа, не в позицию
    options: list[dict] = field(default_factory=list)


def film_for_color(db: Session, color: str, index=None) -> tuple[str, str, float | None] | None:
    """Плёнка для цвета двери — тем же подбором, что при загрузке заданий
    на окутку (services/sku_matching): «Полипропилен Аляска» → (Полипропилен,
    Аляска, толщина). ПЭТ 2Д и 3Д одного цвета → материал «ПЭТ» (тип ПЭТ
    решается у детали). Толщина — если у этой плёнки она одна, иначе None
    (выбирают в окне импорта). Неоднозначно или не найдено — None."""
    from app.services.film_check import pet_of_material
    from app.services.sku_matching import _bare_color, build_sku_match_index, match_sku_by_color_text

    index = index or build_sku_match_index(db)
    sku, cands = match_sku_by_color_text(index, color)
    if sku is not None:
        same = [sku]
    else:
        skus = [index.sku_by_id[c["sku_id"]] for c in cands if c["sku_id"] in index.sku_by_id]
        # Нечёткий подбор цепляет соседние цвета («Белый» → и «Бежевый»):
        # оставляем те, у кого само название цвета совпадает.
        same = [x for x in skus if _bare_color(x.color.name) == _bare_color(color)] or skus
        if len({x.color_id for x in same}) != 1:
            return None
    mats = {x.material.name for x in same}
    if len(mats) == 1:
        material = mats.pop()
    elif all(pet_of_material(m) is not None for m in mats):
        material = "ПЭТ"
    else:
        return None
    # все позиции этой плёнки (материал/цвет) — одна ли у неё толщина
    group = [
        x for x in index.sku_by_id.values()
        if x.color_id == same[0].color_id
        and (x.material.name == material or (material == "ПЭТ" and pet_of_material(x.material.name) is not None))
    ]
    thicknesses = {float(x.thickness.value_mm) for x in group}
    return material, same[0].color.name, (thicknesses.pop() if len(thicknesses) == 1 else None)


def _norm_color(v: str) -> str:
    return " ".join(re.sub(r"\(.*?\)", " ", v).lower().replace("ё", "е").split())


def _film_text(params: dict) -> str:
    t = params.get("толщина_плёнки")
    return f"{params.get('материал_плёнки')} {params.get('цвет_плёнки')}" + (f" {float(t):g} мм" if t not in (None, "") else "")


def _color_option(
    db: Session, prop, color: str, chosen_sku_id: int | None = None, user_id: int | None = None
) -> tuple[object | None, str | None]:
    """Цвет двери = плёнка (services/door_colors): текст из графика — синоним
    варианта, сам вариант — плёнка из справочника. Порядок: плёнка, выбранная
    в окне импорта → вариант по названию/синониму с плёнкой → подбор плёнки
    как в заданиях на окутку. Плёнка не нашлась — (None, None): строку
    не принять, пока плёнку не выберут."""
    from app.models.dictionaries import MaterialSku
    from app.services import door_colors as dc

    if chosen_sku_id is not None:
        sku = db.get(MaterialSku, chosen_sku_id)
        if sku is not None:
            opt, note = dc.option_for_film(db, prop, (sku.material.name, sku.color.name, float(sku.thickness.value_mm)), color, user_id)
            return opt, note or (f"«{color}» → «{opt.value}» (выбрана)" if dc.norm(color) != dc.norm(opt.value) else None)
    opt = dc.find_option(prop, color, db)
    if opt is not None and dc.has_film(opt):
        return opt, None
    film = film_for_color(db, color)
    if film is None:
        return None, None
    opt, note = dc.option_for_film(db, prop, film, color, user_id)
    return opt, note or (f"«{color}» → «{opt.value}»" if dc.norm(color) != dc.norm(opt.value) else None)


@dataclass
class ColorFilm:
    """Цвет из графика и его плёнка — для блока «Цвета и плёнка» в окне
    импорта: подобранная плёнка и возможность выбрать другую."""
    color: str
    option: str | None
    film: str | None  # привязка цвета подписью
    sku_id: int | None  # плёнка, если привязка указывает на одну (материал, цвет, толщина)
    status: str  # ok — плёнка одна; choose — несколько толщин; none — не найдена
    rows: int = 0


def _color_films(db: Session, prop, colors: dict[str, int]) -> list[ColorFilm]:
    from app.services import door_colors as dc, type_rules
    from app.services.film_check import pet_of_material

    out = []
    for color, n in colors.items():
        opt = dc.find_option(prop, color, db)
        params = (opt.params or {}) if opt is not None else {}
        cands = type_rules.film_candidates(db, opt.value) if opt is not None and dc.has_film(opt) else []
        specs = {(s.material_id, s.color_id, s.thickness_id) for s in cands}
        status = "ok" if len(specs) == 1 else ("choose" if specs else "none")
        if status == "choose":
            # ПЭТ 2Д и 3Д одного цвета — не выбор: тип ПЭТ решается у детали
            by_pet: dict = {}
            for s_ in cands:
                by_pet.setdefault(pet_of_material(s_.material.name), set()).add((s_.material_id, s_.color_id, s_.thickness_id))
            if None not in by_pet and all(len(v) == 1 for v in by_pet.values()):
                status = "pet"
        out.append(ColorFilm(
            color=color, option=opt.value if opt is not None and dc.has_film(opt) else None,
            film=_film_text(params) if opt is not None and dc.has_film(opt) else None,
            sku_id=cands[0].id if len(specs) == 1 else None,
            status=status, rows=n,
        ))
    return sorted(out, key=lambda c: ({"none": 0, "choose": 1, "pet": 2, "ok": 3}[c.status], c.color))


def _values_for_row(
    type_: ItemType, tpl: Template, row: TemplateRow, db: Session | None = None, color_films: dict[str, int] | None = None
) -> tuple[dict[int, object], list[str]]:
    props = {p.code: p for p in type_.properties}
    errors: list[str] = []
    by_code: dict[str, object] = {}
    for col in tpl.columns:
        role = col.get("role")
        if role == "size":
            w_code, h_code = col.get("codes") or [None, None]
            text = tpl.column_text(row, w_code)
            size = parse_size(text)
            if size is None:
                errors.append(f"размер «{text}» не разобран (ждём «800х2000»)")
            else:
                by_code[w_code], by_code[h_code] = float(size[0]), float(size[1])
            continue
        if role != "property":
            continue
        p = props.get(col.get("code"))
        if p is None:
            errors.append(f"У типа «{type_.name}» нет свойства «{col.get('code')}»")
            continue
        if p.code == type_rules.COLOR_CODE and p.value_type == "list":
            color = tpl.color_text(row, p.code)
            if not color:
                errors.append("не указан цвет")
                continue
            opt_id = _color_value(db, p, color, tpl.column_text(row, p.code), color_films)
            if opt_id is None:
                errors.append(f"цвет «{color}»: плёнка не найдена в справочнике — выберите плёнку в блоке «Цвета и плёнка»")
            else:
                by_code[p.code] = opt_id
            continue
        text = tpl.color_text(row, p.code) if col.get("from_name") else " ".join(tpl.column_text(row, p.code).split())
        if not text:
            if p.is_required:
                errors.append(f"не указано: {p.name}")
            continue
        if p.value_type == "list":
            opt = match_option(p, text)
            if opt is None:
                errors.append(f"{p.name.lower()} «{text}» нет в списке вариантов типа")
            else:
                by_code[p.code] = opt.value
                by_code[f"__option__{p.code}"] = opt
        elif p.value_type == "number":
            try:
                by_code[p.code] = float(text.replace(",", ".").replace(" ", ""))
            except ValueError:
                errors.append(f"{p.name}: «{text}» — не число")
        elif p.value_type == "bool":
            by_code[p.code] = text.lower() in ("да", "1", "+", "есть", "true")
        else:
            by_code[p.code] = text
    if errors:
        return {}, errors
    apply_rules(tpl, props, by_code, row.name_text)
    values: dict[int, object] = {}
    for code, v in by_code.items():
        p = props.get(code)
        if p is None or code.startswith("__"):
            continue
        if p.value_type == "list" and not (p.code == type_rules.COLOR_CODE and isinstance(v, int)):
            if v in (None, ""):
                continue
            opt = next((o for o in p.options if o.value == v), None) or match_option(p, str(v))
            if opt is None:
                return {}, [f"{p.name}: варианта «{v}» нет в списке свойства"]
            v = opt.id
        values[p.id] = v
    return values, []


def _color_value(db: Session | None, prop, color: str, column_text: str, color_films: dict[str, int] | None) -> int | None:
    """Цвет двери = плёнка (02.10): «Цвет» у типа — плёнки из справочника,
    текст графика — синоним (services/door_colors)."""
    from app.services import door_colors as dc

    chosen = (color_films or {}).get(_norm_color(color))
    if db is not None:
        opt, note = _color_option(db, prop, color, chosen)
        if note:
            _ROW_NOTES.append(note)
    else:
        opt = dc.find_option(prop, color) or dc.find_option(prop, column_text or "")
    return opt.id if opt is not None else None


def _model_prop(t: ItemType):
    return next((p for p in t.properties if p.id == t.model_property_id), None)


def same_columns(a: ItemType, b: ItemType) -> bool:
    """Шаблоны с одинаковыми колонками — строки одного графика/счёта можно
    разбирать по любому из них, а тип выбирать по серии (16.10)."""
    ta, tb = Template.of(a.import_template), Template.of(b.import_template)
    key = lambda t: [(c.get("role"), c.get("code"), tuple(c.get("codes") or [])) for c in t.columns]  # noqa: E731
    return ta is not None and tb is not None and key(ta) == key(tb)


def detect_type(types: list[ItemType], tpl: Template, row: TemplateRow) -> ItemType | None:
    """Тип строки по серии: чей список серий её знает (щитовые А/В/Е/Н,
    царговые М/МГ/МО/С/МОН — у каждого типа свой список)."""
    for t in types:
        prop = _model_prop(t)
        text = " ".join(tpl.column_text(row, prop.code).split()) if prop is not None else ""
        if text and prop.value_type == "list" and match_option(prop, text) is not None:
            return t
    return None


def import_types(db: Session, type_id: int | None) -> tuple[ItemType | None, list[ItemType]]:
    """Тип импорта: выбранный — только он; не выбран («по серии») — все
    изделия с шаблоном импорта, тип строки определяется по серии."""
    if type_id is not None:
        return db.get(ItemType, type_id), []
    types = [
        t for t in db.query(ItemType).filter(ItemType.is_active.is_(True)).order_by(ItemType.sort_order, ItemType.id)
        if t.kind is not None and t.kind.code == "izdelie" and t.import_template and t.name_template
    ]
    return (types[0], types[1:]) if types else (None, [])


_PARENS_RE = re.compile(r"\([^()]*\)")
_DIM_SEP_RE = re.compile(r"(?<=\d)\s*[хxХX×*]\s*(?=\d)")


def _paren_groups(name: str) -> list[tuple[int, int]]:
    """Скобки верхнего уровня (вложенные — внутри): «… (ПЭТ Бежевый (cream silk))»
    — одна группа целиком. [(начало, конец)]."""
    out, depth, start = [], 0, 0
    for i, ch in enumerate(name or ""):
        if ch == "(":
            if depth == 0:
                start = i
            depth += 1
        elif ch == ")" and depth:
            depth -= 1
            if depth == 0:
                out.append((start, i + 1))
    return out


def _strip_parens(name: str) -> str:
    t = name or ""
    for a, b in reversed(_paren_groups(t)):
        t = t[:a] + " " + t[b:]
    return t


def product_key(name: str) -> str:
    """Название без скобок (цвет, «белый УК-6») и с одним знаком размера:
    «Коробка с упл. (белый УК-6) телескоп МДФ 32*75*2070» и «Коробка с упл.
    телескоп МДФ 32х75х2070 (Бетон тёмный ВДМ)» — одно и то же."""
    t = _DIM_SEP_RE.sub("х", _strip_parens((name or "").lower().replace("ё", "е")))
    return " ".join(t.split())


def decor_of(name: str) -> str | None:
    """Декор строки — последние скобки в конце, со вложенными: «Наличник …
    (Бетон тёмный ВДМ)», «Коробка … (ПЭТ Бежевый (cream silk))»."""
    t = (name or "").rstrip()
    g = _paren_groups(t)
    if not g or g[-1][1] != len(t):
        return None
    a, b = g[-1]
    return " ".join(t[a + 1 : b - 1].split()) or None


_SEAL_RE = re.compile(r"\bук-?\s*\d|уплотнит", re.I)


def _groups_text(name: str, drop_decor: bool) -> list[str]:
    t = (name or "").rstrip()
    g = _paren_groups(t)
    if drop_decor and g and g[-1][1] == len(t):
        g = g[:-1]
    return [" ".join(t[a + 1 : b - 1].split()) for a, b in g]


def seal_of(name: str) -> str | None:
    """Цвет уплотнителя из скобок («серо-белый УК-6») — выбирается при запуске,
    позицию не меняет (26.10): в примечание строки заказа."""
    hits = [s for s in _groups_text(name, True) if _SEAL_RE.search(s)]
    return "; ".join(hits) or None


def qualifiers(name: str, drop_decor: bool) -> tuple[str, ...]:
    """Уточнения в скобках («серия Б») — чем отличаются позиции с одним ключом;
    у строки счёта последние скобки — декор, не в счёт. Цвет уплотнителя
    («белый УК-6») — не уточнение позиции (26.10): выбирается при запуске."""
    return tuple(sorted(s.lower().replace("ё", "е") for s in _groups_text(name, drop_decor) if not _SEAL_RE.search(s)))


class ProductIndex:
    """Готовые изделия без серии (погонаж: добор, коробка, наличник…) — по
    названию из счёта (16.10): точное имя или синоним, иначе тот же ключ
    названия (product_key). Индекс строится один раз на импорт."""

    def __init__(self, db: Session):
        from app.models.items import ItemKind

        self.db = db
        kind = db.query(ItemKind).filter(ItemKind.code == "izdelie").first()
        self.kind_id = kind.id if kind else None
        self.by_key: dict[str, list[Item]] = {}
        if self.kind_id is not None:
            for it in db.query(Item).filter(Item.kind_id == self.kind_id, Item.is_model.is_(False), Item.is_active.is_(True)):
                self.by_key.setdefault(product_key(it.name), []).append(it)

    def find(self, text: str) -> tuple[Item | None, str | None]:
        """(позиция, ошибка). Несколько с одним ключом — по уточнению в скобках
        («белый УК-6» ≠ «серо-белый УК-6», 21.10); всё равно несколько —
        ошибка, варианты — в self.last_candidates (выбор в окне загрузки)."""
        from app.services.item_aliases import find_item
        from app.services.naryad_import import base_name

        self.last_candidates: list[Item] = []
        if self.kind_id is None:
            return None, None
        hit = find_item(self.db, text, self.kind_id) or find_item(self.db, base_name(text), self.kind_id)
        if hit is not None and not hit.is_model:
            return hit, None
        found = self.by_key.get(product_key(text), [])
        q = qualifiers(text, drop_decor=True)
        if q:
            # уточнение в счёте («серо-белый УК-6») — только позиция с ним же;
            # нет такой — новое изделие, а не соседнее «белый УК-6»
            found = [i for i in found if qualifiers(i.name, drop_decor=False) == q]
        elif len(found) > 1:
            plain = [i for i in found if not qualifiers(i.name, drop_decor=False)]
            found = plain if len(plain) == 1 else found
        if len(found) > 1:
            # цвет уплотнителя выбирают при запуске (26.10): позиция без него в названии
            noseal = [i for i in found if not seal_of(i.name)]
            found = noseal if len(noseal) == 1 else found
        if len(found) == 1:
            return found[0], None
        if len(found) > 1:
            self.last_candidates = found
            return None, "подходит несколько позиций — выберите нужную (запомнится)"
        return None, None


_LAT2CYR = str.maketrans("ABCEHKMOPTXY", "АВСЕНКМОРТХУ")
_TRIM_WORDS = re.compile(r"добор|коробк|наличник|плинтус|планк|погонаж|капител|порог", re.I)


def add_series(db: Session, types: list[ItemType], series_text: str) -> tuple[ItemType, str] | None:
    """Новая серия из счёта (19.10): заводится в тип, где уже есть серии той же
    буквы («В-40» → щитовые, «С-7» → царговые), с параметрами как у соседних
    серий этой буквы (толщины, кромка). Букву не знает ни один тип — None."""
    from collections import Counter
    import json

    from app.models.items import ItemPropertyOption

    value = re.sub(r"\.\d$", "", " ".join(series_text.split())).upper().translate(_LAT2CYR)
    m = re.match(r"^([А-ЯЁ]{1,3})-\d", value)
    if not m:
        return None
    pref = m.group(1) + "-"
    owners = []
    for t in types:
        prop = _model_prop(t)
        if prop is None or prop.value_type != "list":
            continue
        sibs = [o for o in prop.options if o.is_active and o.value.upper().translate(_LAT2CYR).startswith(pref) and "/" not in o.value and " " not in o.value]
        if sibs:
            owners.append((t, prop, sibs))
    if len(owners) != 1:
        return None
    t, prop, sibs = owners[0]
    common = Counter(json.dumps({k: v for k, v in (o.params or {}).items() if k != "синонимы"}, ensure_ascii=False, sort_keys=True) for o in sibs)
    params = json.loads(common.most_common(1)[0][0])
    like = next(o.value for o in sibs if {k: v for k, v in (o.params or {}).items() if k != "синонимы"} == params)
    prop.options.append(ItemPropertyOption(value=value, params=params, sort_order=max(o.sort_order for o in prop.options) + 1, is_active=True))
    db.flush()
    return t, like


def new_product(db: Session, name_text: str) -> Item:
    """Изделие без серии, которого нет в номенклатуре (19.10): заводится с
    названием из счёта без скобок с цветом; погонаж — по словам названия.
    Без типа и маршрута — в заказе идёт без этапов («в работе» → «Готово»)."""
    from app.models.items import ItemKind
    from app.services.naryad_import import base_name

    kind = db.query(ItemKind).filter(ItemKind.code == "izdelie").one()
    name = " ".join(base_name(name_text).split())[:255]
    hit = db.query(Item).filter(Item.kind_id == kind.id, func.lower(Item.name) == name.lower()).first()
    if hit is not None:
        return hit
    trim = bool(_TRIM_WORDS.search(name))
    sib = None
    if trim:
        sib = db.query(Item).filter(Item.kind_id == kind.id, Item.direction == "trim", Item.is_model.is_(False), Item.group_id.isnot(None)).first()
    item = Item(kind_id=kind.id, name=name, is_active=True, direction="trim" if trim else None, group_id=sib.group_id if sib else None)
    db.add(item)
    db.flush()
    return item


def import_schedule(
    db: Session, *, text: str, type_: ItemType, order_name: str | None, user_id: int, dry_run: bool,
    color_films: dict[str, int] | None = None, colors_out: list | None = None,
    invoice_no: str | None = None, ship_date=None, other_types: list[ItemType] | None = None,
    item_choices: dict[str, int] | None = None,
) -> tuple[list[ImportRow], list[str], ProductionOrder | None]:
    """dry_run — только предпросмотр. Иначе — позиции по типу и черновик
    заказа; если хоть одна строка с ошибкой — ничего не создаётся.
    other_types — смешанный счёт (16.10): тип строки — по серии среди
    type_ и этих (с теми же колонками шаблона); серию не знает никто — ошибка."""
    tpl = Template.of(type_.import_template)
    if tpl is None:
        return [], [f"У типа «{type_.name}» не настроен шаблон импорта графика — «Номенклатура → Типы и правила»"], None
    rows, parse_errors = parse_rows(text, tpl)
    model_code = next((p.code for p in type_.properties if p.id == type_.model_property_id), None)
    from app.services.import_template import fill_from_name

    for r in rows:
        fill_from_name(tpl, r, model_code)  # счёт 1С: серия и размер — из наименования
        if invoice_no and not r.invoice_no:
            r.invoice_no = invoice_no
        if ship_date and not r.ship_date:
            r.ship_date = ship_date
    first_prop = next((c.get("code") for c in tpl.columns if c.get("role") == "property"), None)
    size_col = next((c for c in tpl.columns if c.get("role") == "size"), None)
    color_code = type_rules.COLOR_CODE
    # выбранная в окне импорта плёнка: цвет графика → позиция плёнки
    choices = {_norm_color(k): v for k, v in (color_films or {}).items()}
    candidates = [type_] + [t for t in (other_types or []) if t.id != type_.id and same_columns(type_, t)]
    seen_colors: dict[str, int] = {}
    out: list[ImportRow] = []
    values_by_row: list[dict[int, object]] = []
    row_types: list[ItemType] = []
    row_items: list[Item | None] = []  # изделие без серии — найдено по названию (погонаж)
    products: ProductIndex | None = None
    for r in rows:
        rt = detect_type(candidates, tpl, r) if len(candidates) > 1 else type_
        new_series_note = None
        if rt is None or (len(candidates) == 1 and _model_prop(type_) is not None):
            ser_text = " ".join(tpl.column_text(r, model_code or first_prop or "").split())
            prop0 = _model_prop(rt or type_)
            known = rt is not None and prop0 is not None and (not ser_text or match_option(prop0, ser_text) is not None)
            if ser_text and not known:
                added = add_series(db, candidates, ser_text)
                if added is not None:
                    rt = added[0]
                    new_series_note = f"новая серия «{ser_text}» → {rt.name}, параметры как у {added[1]}"
        row_types.append(rt or type_)
        ir = ImportRow(
            series=tpl.column_text(r, model_code or first_prop or ""),
            size=tpl.column_text(r, size_col["codes"][0]) if size_col else "",
            color=tpl.color_text(r, color_code) or tpl.column_text(r, color_code), name_text=r.name_text, qty=r.qty,
            invoice_no=r.invoice_no, ship_date=r.ship_date.isoformat() if r.ship_date else None,
        )
        _ROW_NOTES.clear()
        row_items.append(None)
        if rt is None:
            ser = tpl.column_text(r, model_code or first_prop or "")
            if not ser:  # без серии — готовое изделие по названию (добор, коробка, наличник)
                products = products or ProductIndex(db)
                item, err = products.find(r.name_text)
                chosen = (item_choices or {}).get(r.name_text)
                if item is None and chosen and any(c.id == chosen for c in products.last_candidates):
                    # выбрали в окне загрузки — запомнить синонимом, дальше найдётся сам
                    item, err = db.get(Item, chosen), None
                    if not dry_run:
                        from app.services.item_aliases import add_alias
                        from app.services.naryad_import import base_name

                        try:
                            add_alias(db, item, base_name(r.name_text), source="счёт: выбор позиции", user_id=user_id)
                        except ValueError:
                            pass  # текст уже синоним другой позиции — выбор только для этой загрузки
                from app.services import line_options

                ir.options = line_options.seal_option(r.name_text)
                if item is not None:
                    row_items[-1] = item
                    ir.item_id, ir.item_name, ir.exists = item.id, item.name, True
                    ir.type_name = "по названию"
                    ir.series, ir.size = "", ""
                    ir.color = decor_of(r.name_text) or ""
                    out.append(ir)
                    values_by_row.append({})
                    continue
                if err:
                    ir.errors.append(err)
                    ir.candidates = [{"id": c.id, "name": c.name} for c in products.last_candidates]
                else:
                    # нет в номенклатуре — заведётся при создании заказа (19.10)
                    from app.services.naryad_import import base_name

                    ir.item_name = " ".join(base_name(r.name_text).split())
                    ir.exists, ir.type_name = False, "новое изделие"
                    ir.series, ir.size, ir.color = "", "", decor_of(r.name_text) or ""
                    ir.notes.append("новое изделие — заведётся без этапов («в работе» → «Готово»)")
                    row_items[-1] = "__new__"
                out.append(ir)
                values_by_row.append({})
                continue
            ir.errors.append(f"серия «{ser}» не найдена ни у одного типа ({', '.join(t.name for t in candidates)}) — добавьте её в «Номенклатура → Типы и правила»")
            out.append(ir)
            values_by_row.append({})
            continue
        ir.type_name = rt.name
        if new_series_note:
            ir.notes.append(new_series_note)
        values, errors = _values_for_row(rt, tpl, r, db, choices)
        from app.services import line_options

        values, ir.options = line_options.split_values(db, rt, values)
        c = tpl.color_text(r, color_code)
        cprop = next((p for p in rt.properties if p.code == color_code), None)
        if c and rt.id == type_.id and cprop is not None and cprop.value_type == "list":
            seen_colors[c] = seen_colors.get(c, 0) + 1
        ir.errors.extend(errors)
        ir.notes.extend(_ROW_NOTES)
        if not errors:
            res = type_rules.compute(db, rt, type_rules.context_from_values(db, rt, values))
            ir.errors.extend(res.errors)
            ir.notes.extend(res.notes)
            ir.item_name = res.name
            if res.name:
                existing = db.query(Item).filter(Item.kind_id == rt.kind_id, func.lower(Item.name) == res.name.lower()).first()
                ir.exists = existing is not None
                ir.item_id = existing.id if existing else None
        out.append(ir)
        values_by_row.append(values)
    if colors_out is not None:
        prop = next((p for p in type_.properties if p.code == color_code), None)
        if prop is not None and prop.value_type == "list":
            colors_out.extend(_color_films(db, prop, seen_colors))
    if dry_run or not rows or parse_errors or any(r.errors for r in out):
        return out, parse_errors, None

    ship_dates = [r.ship_date for r in rows if r.ship_date]
    name = (order_name or "").strip()
    if not name:
        name = f"График, отгрузка с {min(ship_dates).strftime('%d.%m.%Y')}" if ship_dates else "График"
    order = ProductionOrder(
        name=name, ship_date=min(ship_dates) if ship_dates else None, status=ORDER_DRAFT, created_by=user_id,
    )
    db.add(order)
    db.flush()
    for i, (ir, values, r, rt, fixed) in enumerate(zip(out, values_by_row, rows, row_types, row_items), start=1):
        if fixed == "__new__":
            item = new_product(db, r.name_text)
            ir.item_id, ir.item_name = item.id, item.name
        elif fixed is not None:
            item = fixed
        else:
            item, created, errors = type_rules.ensure_item(db, rt, values)
            if errors:
                ir.errors.extend(errors)
                return out, parse_errors, None
            ir.item_id, ir.item_name, ir.exists = item.id, item.name, not created
        notes = [f"отгрузка {r.ship_date.strftime('%d.%m')}" if r.ship_date else None]
        if (fixed is not None) and decor_of(r.name_text):
            notes.append(f"декор: {decor_of(r.name_text)}")
        note = ", ".join(n for n in notes if n) or None
        order.lines.append(ProductionOrderLine(
            item_id=item.id, quantity=r.qty, note=note, invoice_no=(r.invoice_no or "").strip() or None, sort_order=i,
            options=ir.options or None,
            source_text=(getattr(r, "name_text", "") or "").strip()[:500] or None,
        ))
    db.flush()
    return out, parse_errors, order
