"""Импорт графика запуска щитовых дверей в заказ на производство (единая
модель). Разбор строк — services/shield_schedule.py; здесь строка графика
становится значениями свойств типа «Щитовая дверь» (по кодам свойств:
серия, ширина, высота, цвет, стекло, молдинг, замок, кромка, цвет_кромки), позиция
находится или создаётся по типу, строка — строкой заказа."""

import re
from dataclasses import dataclass, field

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.items import Item, ItemType
from app.models.production_orders import ORDER_DRAFT, ProductionOrder, ProductionOrderLine
from app.services import type_rules
from app.services.shield_schedule import ScheduleRow, parse_line_features, parse_pasted_schedule, parse_size, series_key

_ROW_NOTES: list[str] = []  # пометки разбора текущей строки (новый цвет и т.п.)
REQUIRED_CODES = ("серия", "ширина", "высота", "цвет", "стекло", "молдинг", "замок", "кромка", "цвет_кромки")


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


def color_from_name(name_text: str, color_text: str) -> str:
    """Цвет двери из наименования строки графика: «В-10.2 (…) 800х2000 -
    ПЭТ Бежевый (cream silk) кромка черная ABS 2мм» → «ПЭТ Бежевый (cream
    silk)». Модель — серия, цвет — отдельно (решение 01.10). Не разобрали —
    колонка «Цвет»."""
    tail = name_text.split(" - ", 1)[1] if " - " in name_text else ""
    tail = re.split(r"\s+кромка\b|\s+\(стекло|\s+\(Защелка|\s+\(защелка", tail, maxsplit=1)[0]
    # Скобки с фурнитурой — не цвет: «(PL410 + петли AGB Eclipse 3.0)».
    tail = re.sub(r"\((?=[^)]*(?:петл|PL\d|AGB|защел|стекл))[^)]*\)", " ", tail, flags=re.I)
    return " ".join(tail.split()) or " ".join((color_text or "").split())


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
    type_: ItemType, row: ScheduleRow, db: Session | None = None, color_films: dict[str, int] | None = None
) -> tuple[dict[int, object], list[str]]:
    props = {p.code: p for p in type_.properties}
    missing = [c for c in REQUIRED_CODES if c not in props]
    if missing:
        return {}, [f"У типа «{type_.name}» нет свойств: {', '.join(missing)}"]
    errors: list[str] = []
    by_key = {series_key(o.value): o for o in props["серия"].options if o.is_active}
    series = by_key.get(series_key(row.series_text))
    if series is None:
        errors.append(f"серии «{row.series_text}» нет в списке серий типа")
    size = parse_size(row.size_text)
    if size is None:
        errors.append(f"размер «{row.size_text}» не разобран (ждём «800х2000»)")
    color = color_from_name(row.name_text, row.color_text)
    if not color:
        errors.append("не указан цвет")
    # Цвет двери = плёнка (02.10): «Цвет» у типа — плёнки из справочника,
    # текст графика — синоним (services/door_colors).
    color_value: object = color
    if color and props["цвет"].value_type == "list":
        from app.services import door_colors as dc

        chosen = (color_films or {}).get(_norm_color(color))
        if db is not None:
            opt, note = _color_option(db, props["цвет"], color, chosen)
            if note:
                _ROW_NOTES.append(note)
        else:
            opt = dc.find_option(props["цвет"], color) or dc.find_option(props["цвет"], row.color_text or "")
        if opt is None:
            errors.append(f"цвет «{color}»: плёнка не найдена в справочнике — выберите плёнку в блоке «Цвета и плёнка»")
        else:
            color_value = opt.id
    if errors:
        return {}, errors
    features = parse_line_features(row.name_text, (series.params or {}).get("кромка") or "abs")
    edge = next((o for o in props["кромка"].options if o.value == features.edge_type), None)
    if edge is None:
        return {}, [f"кромки «{features.edge_type}» нет в вариантах свойства «Кромка»"]
    return {
        props["серия"].id: series.id,
        props["ширина"].id: float(size[0]),
        props["высота"].id: float(size[1]),
        props["цвет"].id: color_value,
        props["стекло"].id: features.glass,  # вид стекла, "" — без стекла
        props["молдинг"].id: features.has_moulding,
        props["замок"].id: features.needs_lock_milling,
        props["кромка"].id: edge.id,
        props["цвет_кромки"].id: features.edge_text,
    }, []


def import_schedule(
    db: Session, *, text: str, type_: ItemType, order_name: str | None, user_id: int, dry_run: bool,
    color_films: dict[str, int] | None = None, colors_out: list | None = None,
) -> tuple[list[ImportRow], list[str], ProductionOrder | None]:
    """dry_run — только предпросмотр. Иначе — позиции по типу и черновик
    заказа; если хоть одна строка с ошибкой — ничего не создаётся."""
    rows, parse_errors = parse_pasted_schedule(text)
    # выбранная в окне импорта плёнка: цвет графика → позиция плёнки
    choices = {_norm_color(k): v for k, v in (color_films or {}).items()}
    seen_colors: dict[str, int] = {}
    out: list[ImportRow] = []
    values_by_row: list[dict[int, object]] = []
    for r in rows:
        ir = ImportRow(
            series=r.series_text, size=r.size_text, color=r.color_text, name_text=r.name_text, qty=r.doors_qty,
            invoice_no=r.invoice_no, ship_date=r.ship_date.isoformat() if r.ship_date else None,
        )
        _ROW_NOTES.clear()
        values, errors = _values_for_row(type_, r, db, choices)
        c = color_from_name(r.name_text, r.color_text)
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
        prop = next((p for p in type_.properties if p.code == "цвет"), None)
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
        note = "; ".join(x for x in (f"счёт {r.invoice_no}" if r.invoice_no else "", r.ship_date.strftime("%d.%m") if r.ship_date else "") if x)
        order.lines.append(ProductionOrderLine(item_id=item.id, quantity=r.doors_qty, note=note or None, sort_order=i))
    db.flush()
    return out, parse_errors, order
