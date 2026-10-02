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
    errors: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


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
        text = " ".join(tpl.column_text(row, p.code).split())
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


def import_schedule(
    db: Session, *, text: str, type_: ItemType, order_name: str | None, user_id: int, dry_run: bool,
    color_films: dict[str, int] | None = None, colors_out: list | None = None,
) -> tuple[list[ImportRow], list[str], ProductionOrder | None]:
    """dry_run — только предпросмотр. Иначе — позиции по типу и черновик
    заказа; если хоть одна строка с ошибкой — ничего не создаётся."""
    tpl = Template.of(type_.import_template)
    if tpl is None:
        return [], [f"У типа «{type_.name}» не настроен шаблон импорта графика — «Номенклатура → Типы и правила»"], None
    rows, parse_errors = parse_rows(text, tpl)
    model_code = next((p.code for p in type_.properties if p.id == type_.model_property_id), None)
    first_prop = next((c.get("code") for c in tpl.columns if c.get("role") == "property"), None)
    size_col = next((c for c in tpl.columns if c.get("role") == "size"), None)
    color_code = type_rules.COLOR_CODE
    # выбранная в окне импорта плёнка: цвет графика → позиция плёнки
    choices = {_norm_color(k): v for k, v in (color_films or {}).items()}
    seen_colors: dict[str, int] = {}
    out: list[ImportRow] = []
    values_by_row: list[dict[int, object]] = []
    for r in rows:
        ir = ImportRow(
            series=tpl.column_text(r, model_code or first_prop or ""),
            size=tpl.column_text(r, size_col["codes"][0]) if size_col else "",
            color=tpl.column_text(r, color_code), name_text=r.name_text, qty=r.qty,
            invoice_no=r.invoice_no, ship_date=r.ship_date.isoformat() if r.ship_date else None,
        )
        _ROW_NOTES.clear()
        values, errors = _values_for_row(type_, tpl, r, db, choices)
        c = tpl.color_text(r, color_code)
        if c:
            seen_colors[c] = seen_colors.get(c, 0) + 1
        ir.errors.extend(errors)
        ir.notes.extend(_ROW_NOTES)
        if not errors:
            res = type_rules.compute(db, type_, type_rules.context_from_values(db, type_, values))
            ir.errors.extend(res.errors)
            ir.item_name = res.name
            if res.name:
                existing = db.query(Item).filter(Item.kind_id == type_.kind_id, func.lower(Item.name) == res.name.lower()).first()
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
    for i, (ir, values, r) in enumerate(zip(out, values_by_row, rows), start=1):
        item, created, errors = type_rules.ensure_item(db, type_, values)
        if errors:
            ir.errors.extend(errors)
            return out, parse_errors, None
        ir.item_id, ir.item_name, ir.exists = item.id, item.name, not created
        note = f"отгрузка {r.ship_date.strftime('%d.%m')}" if r.ship_date else None
        order.lines.append(ProductionOrderLine(
            item_id=item.id, quantity=r.qty, note=note, invoice_no=(r.invoice_no or "").strip() or None, sort_order=i,
        ))
    db.flush()
    return out, parse_errors, order
