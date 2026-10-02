"""Цвет двери = плёнка (решение 02.10): двери бывают только в плёнке, поэтому
цвет — это позиция справочника плёнок, а не свой список. Вариант свойства
«Цвет» у типа хранит привязку к плёнке (материал, цвет, толщина) и
называется по ней («ПЭТ Бежевый», «ПВХ Бетон темный»); тексты из графиков
запуска («ПЭТ Бежевый (cream silk)», «Бетон тёмный ВДМ») — синонимы для
сопоставления, в названиях позиций не участвуют."""

import re

from sqlalchemy.orm import Session

from app.models.items import ItemPropertyOption, ItemPropertyValue

MATERIAL, COLOR, THICKNESS, SYNONYMS = "материал_плёнки", "цвет_плёнки", "толщина_плёнки", "синонимы"


def norm(v: str) -> str:
    """Сравнение цветов: без пояснения в скобках, регистра, ё."""
    return " ".join(re.sub(r"\(.*?\)", " ", v or "").lower().replace("ё", "е").split())


def _label_material(material: str) -> str:
    # ПЭТ 2Д/3Д решается у детали — в названии цвета просто «ПЭТ»
    return "ПЭТ" if norm(material).startswith("пэт") else material


def film_label(material: str, color: str) -> str:
    return f"{_label_material(material)} {color}".strip()


def has_film(opt: ItemPropertyOption) -> bool:
    return bool((opt.params or {}).get(COLOR))


def synonyms(opt: ItemPropertyOption) -> list[str]:
    return list((opt.params or {}).get(SYNONYMS) or [])


def find_option(prop, text: str, db: Session | None = None) -> ItemPropertyOption | None:
    """Вариант по названию, синониму или общему сопоставлению плёнки
    (services/film_aliases) — без скобок и регистра."""
    key = norm(text)
    if not key:
        return None
    opts = [o for o in prop.options if o.is_active]
    opt = next((o for o in opts if norm(o.value) == key), None) or next(
        (o for o in opts if any(norm(s) == key for s in synonyms(o))), None
    )
    if opt is None and db is not None:
        from app.models.dictionaries import Color, Material
        from app.services.film_aliases import find_alias

        a = find_alias(db, text)
        if a is not None:
            m, c = db.get(Material, a.material_id), db.get(Color, a.color_id)
            k = _film_key(m.name, c.name) if m and c else None
            opt = next(
                (o for o in opts if has_film(o) and _film_key(str(o.params.get(MATERIAL) or ""), str(o.params[COLOR])) == k),
                None,
            )
    return opt


def _save_global_alias(db: Session, text: str, material: str, color: str, thickness: float | None, user_id: int | None) -> bool:
    """Текст источника → общее сопоставление плёнки. Только для настоящей
    позиции справочника: «ПЭТ» без 2Д/3Д общим не делаем (тип решается у
    детали — наряд с ПЭТ 3Д не должен попасть в 2Д)."""
    from sqlalchemy import func

    from app.models.dictionaries import Color, Material, MaterialSku, Thickness
    from app.services.film_aliases import save_alias

    # по позиции плёнки, а не по названию цвета: в справочнике бывают цвета,
    # отличающиеся только регистром («Белое дерево» / «Белое Дерево»)
    q = (
        db.query(MaterialSku)
        .join(Material, Material.id == MaterialSku.material_id)
        .join(Color, Color.id == MaterialSku.color_id)
        .join(Thickness, Thickness.id == MaterialSku.thickness_id)
        .filter(func.lower(Material.name) == material.lower(), func.lower(Color.name) == color.lower(), MaterialSku.is_active.is_(True))
    )
    if thickness is not None:
        q = q.filter(Thickness.value_mm == thickness)
    sku = q.order_by(MaterialSku.id).first()
    if sku is None:
        return False
    thickness_ids = {x.thickness_id for x in q.filter(MaterialSku.color_id == sku.color_id)}
    t_id = sku.thickness_id if thickness is not None or len(thickness_ids) == 1 else None
    save_alias(db, text, sku.material_id, sku.color_id, t_id, source="график щитовых", user_id=user_id)
    return True


def _film_key(material: str, color: str) -> tuple[str, str]:
    return norm(_label_material(material)), norm(color)


def option_for_film(
    db: Session, prop, film: tuple[str, str, float | None], synonym: str | None = None, user_id: int | None = None
) -> tuple[ItemPropertyOption, str | None]:
    """Вариант «Цвет» для плёнки: есть — он (синоним добавляется, толщина
    уточняется), нет — заводится с названием по плёнке. Возвращает (вариант,
    пометка для предпросмотра)."""
    material, color, thickness = film
    key = _film_key(material, color)
    opt = next(
        (o for o in prop.options if o.is_active and has_film(o)
         and _film_key(str(o.params.get(MATERIAL) or ""), str(o.params[COLOR])) == key),
        None,
    )
    note = None
    if opt is None:
        label = film_label(material, color)
        clash = next((o for o in prop.options if norm(o.value) == norm(label)), None)
        if clash is not None and not has_film(clash):
            opt = clash  # вариант с таким названием уже есть, но без плёнки — привязываем
        else:
            opt = ItemPropertyOption(property_id=prop.id, value=label, params={}, is_active=True,
                                     sort_order=max([o.sort_order or 0 for o in prop.options] or [0]) + 1)
            db.add(opt)
        note = f"новый цвет «{label}» (плёнка)"
    params = dict(opt.params or {})
    params[MATERIAL], params[COLOR] = material, color
    if thickness is not None and params.get(THICKNESS) != thickness:
        if params.get(THICKNESS) is not None and note is None:
            note = f"цвет «{opt.value}»: толщина плёнки {thickness:g} мм (выбрана)"
        params[THICKNESS] = thickness
    if synonym and norm(synonym) != norm(opt.value):
        # общее сопоставление для всей программы; не вышло (ПЭТ без 2Д/3Д) —
        # синоним цвета двери
        if not _save_global_alias(db, synonym, material, color, thickness, user_id) and all(
            norm(s) != norm(synonym) for s in params.get(SYNONYMS) or []
        ):
            params[SYNONYMS] = [*(params.get(SYNONYMS) or []), synonym]
    opt.params = params
    db.flush()
    db.refresh(prop)
    return opt, note


def normalize_color_options(db: Session, prop) -> list[str]:
    """Привести варианты «Цвет» к справочнику плёнок (без commit): название
    варианта — по плёнке, старое название — в синонимы; варианты одной
    плёнки сливаются (значения позиций переводятся на оставшийся). Вариант
    без плёнки остаётся как есть — в отчёте. Возвращает отчёт строками."""
    report: list[str] = []
    groups: dict[tuple[str, str], list[ItemPropertyOption]] = {}
    from app.services.schedule_import import film_for_color

    for o in prop.options:
        if not o.is_active:
            continue
        if not has_film(o):
            film = film_for_color(db, o.value)
            if film is not None:
                o.params = {**(o.params or {}), MATERIAL: film[0], COLOR: film[1],
                            **({THICKNESS: film[2]} if film[2] is not None else {})}
                report.append(f"плёнка подобрана: «{o.value}» → {film[0]} {film[1]}")
            else:
                report.append(f"без плёнки — оставлен: «{o.value}» (выберите плёнку при импорте или в типе)")
                continue
        groups.setdefault(_film_key(str(o.params.get(MATERIAL) or ""), str(o.params[COLOR])), []).append(o)

    def uses(o):
        return db.query(ItemPropertyValue).filter(ItemPropertyValue.option_id == o.id).count()

    for opts in groups.values():
        keep = max(opts, key=lambda o: (uses(o), -o.id))
        params = dict(keep.params)
        label = film_label(str(params.get(MATERIAL) or ""), str(params[COLOR]))
        syn = list(params.get(SYNONYMS) or [])
        for o in opts:
            for s in [o.value, *synonyms(o)]:
                if norm(s) != norm(label) and all(norm(x) != norm(s) for x in syn):
                    syn.append(s)
            if o is not keep:
                if not params.get(THICKNESS) and (o.params or {}).get(THICKNESS):
                    params[THICKNESS] = o.params[THICKNESS]
                n = db.query(ItemPropertyValue).filter(ItemPropertyValue.option_id == o.id).update(
                    {"option_id": keep.id}, synchronize_session=False
                )
                o.is_active = False
                o.value = f"{o.value} (слит в «{label}», #{o.id})"[:255]
                report.append(f"слит: «{o.value.split(' (слит')[0]}» → «{label}» (позиций: {n})")
        rest = [x for x in syn if not _save_global_alias(
            db, x, str(params.get(MATERIAL) or ""), str(params[COLOR]),
            float(params[THICKNESS]) if params.get(THICKNESS) not in (None, "") else None, None,
        )]
        if len(rest) < len(syn):
            report.append(f"«{label}»: в общие сопоставления — {len(syn) - len(rest)}")
        if rest:
            params[SYNONYMS] = rest
        else:
            params.pop(SYNONYMS, None)
        if keep.value != label:
            report.append(f"переименован: «{keep.value}» → «{label}»")
            # уникальность значения: освобождаем название, если его держит неактивный
            for o in prop.options:
                if o is not keep and o.value == label:
                    o.value = f"{o.value} (#{o.id})"
            db.flush()
            keep.value = label
        keep.params = params
        db.flush()
    db.refresh(prop)
    return report


def color_properties(db: Session) -> list:
    """Свойства «Цвет» изделий, где цвет — плёнка (у варианта есть привязка
    к плёнке или вариантов ещё нет)."""
    from app.models.items import ItemKind, ItemProperty, ItemType

    out = []
    for p in (
        db.query(ItemProperty)
        .join(ItemType, ItemType.id == ItemProperty.type_id)
        .join(ItemKind, ItemKind.id == ItemType.kind_id)
        .filter(ItemProperty.code == "цвет", ItemProperty.value_type == "list", ItemKind.code == "izdelie")
    ):
        if not p.options or any(has_film(o) for o in p.options):
            out.append(p)
    return out


def sync_film_colors(db: Session, prop=None) -> int:
    """Цвета двери = все действующие плёнки справочника (без commit): для
    каждой плёнки (материал + цвет; ПЭТ 2Д/3Д — один цвет «ПЭТ …») без
    варианта заводится вариант с привязкой. Толщина — если у плёнки она одна.
    Варианты снятых с учёта плёнок не трогаем (на них ссылаются позиции).
    Возвращает, сколько вариантов заведено."""
    from app.models.dictionaries import MaterialSku

    props = [prop] if prop is not None else color_properties(db)
    if not props:
        return 0
    films: dict[tuple[str, str], dict] = {}
    for s in db.query(MaterialSku).filter(MaterialSku.is_active.is_(True)):
        if float(s.thickness.value_mm) <= 0 or not s.material.is_active or not s.color.is_active:
            continue
        key = _film_key(s.material.name, s.color.name)
        f = films.setdefault(key, {"material": _label_material(s.material.name), "color": s.color.name, "th": set()})
        f["th"].add(float(s.thickness.value_mm))
    added = 0
    for p in props:
        have = {
            _film_key(str(o.params.get(MATERIAL) or ""), str(o.params[COLOR]))
            for o in p.options if o.is_active and has_film(o)
        }
        values = {norm(o.value): o for o in p.options}
        order = max([o.sort_order or 0 for o in p.options] or [0])
        for key, f in sorted(films.items(), key=lambda kv: film_label(kv[1]["material"], kv[1]["color"])):
            if key in have:
                continue
            label = film_label(f["material"], f["color"])
            params = {MATERIAL: f["material"], COLOR: f["color"]}
            if len(f["th"]) == 1:
                params[THICKNESS] = next(iter(f["th"]))
            clash = values.get(norm(label))
            if clash is not None:
                if has_film(clash) or not clash.is_active:
                    continue  # такое название уже занято другой плёнкой/архивом
                clash.params = {**(clash.params or {}), **params}
            else:
                order += 1
                db.add(ItemPropertyOption(property_id=p.id, value=label, params=params, is_active=True, sort_order=order))
            have.add(key)
            added += 1
        db.flush()
        db.refresh(p)
    return added
