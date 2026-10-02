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


def find_option(prop, text: str) -> ItemPropertyOption | None:
    """Вариант по названию или синониму (без скобок и регистра)."""
    key = norm(text)
    if not key:
        return None
    opts = [o for o in prop.options if o.is_active]
    return next((o for o in opts if norm(o.value) == key), None) or next(
        (o for o in opts if any(norm(s) == key for s in synonyms(o))), None
    )


def _film_key(material: str, color: str) -> tuple[str, str]:
    return norm(_label_material(material)), norm(color)


def option_for_film(
    db: Session, prop, film: tuple[str, str, float | None], synonym: str | None = None
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
    if synonym and norm(synonym) != norm(opt.value) and all(norm(s) != norm(synonym) for s in params.get(SYNONYMS) or []):
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
        if syn:
            params[SYNONYMS] = syn
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
