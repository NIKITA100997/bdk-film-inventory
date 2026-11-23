"""Вывод стабильного code для нового участка (раздел про администрирование
участков) — участок теперь заводится через UI текстом ("Название"), но
код остаётся стабильной строкой в БД (как и было при enum), поэтому его
не даём вводить руками: транслитерация + kebab/snake из названия, с
проверкой уникальности."""

from datetime import date, timedelta

from sqlalchemy.orm import Session

from app.models.areas import Area

# Раздел про падение при создании участка с длинным названием (500
# StringDataRightTruncation вместо понятной ошибки) — колонка areas.code
# сейчас String(128), но название участка ничем не ограничено, а суффикс
# на случай коллизии (unique_area_code ниже) ещё +2-3 символа сверху,
# поэтому обрезаем сам слаг заранее с запасом, а не только увеличиваем
# лимит колонки — иначе баг просто вернётся при ещё более длинном названии.
_MAX_CODE_LEN = 100

_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def slugify(name: str) -> str:
    """Транслитерация в code: "Окутка царговых" -> "okutka_tsargovykh"."""
    lowered = name.strip().lower()
    transliterated = "".join(_TRANSLIT.get(ch, ch) for ch in lowered)
    slug = "".join(ch if ch.isalnum() else "_" for ch in transliterated)
    while "__" in slug:
        slug = slug.replace("__", "_")
    slug = slug.strip("_") or "area"
    return slug[:_MAX_CODE_LEN].rstrip("_") or "area"


def unique_area_code(db: Session, name: str) -> str:
    base = slugify(name)
    code = base
    suffix = 2
    while db.get(Area, code) is not None:
        code = f"{base}_{suffix}"
        suffix += 1
    return code


def cuts_film_on_site(db: Session, area_code: str | None) -> bool:
    """Участок режет плёнку сам (мембранно-вакуумные прессы): выдаётся рулон
    целиком, ширина рулона строке задания не обязана совпадать."""
    if not area_code:
        return False
    area = db.get(Area, area_code)
    return bool(area is not None and area.film_cut_on_site)


def area_capacities(db: Session, with_fact: bool = False) -> dict[str, float]:
    """Мощность участков в день, шт: сумма активных линий участка с
    заданной мощностью (09.10, аудит по станкам), иначе — мощность самого
    участка; × смен в день. Участок без мощности в словарь не попадает."""
    from app.models.production import ProductionLine

    by_lines: dict[str, float] = {}
    for ln in db.query(ProductionLine).filter(ProductionLine.is_active.is_(True), ProductionLine.capacity_per_shift.isnot(None)):
        by_lines[ln.area] = by_lines.get(ln.area, 0.0) + float(ln.capacity_per_shift)
    out: dict[str, float] = {}
    for a in db.query(Area):
        per_shift = by_lines.get(a.code) or (float(a.capacity_per_shift) if a.capacity_per_shift else None)
        if per_shift:
            out[a.code] = round(per_shift * (a.shifts_per_day or 1), 2)
    if with_fact:
        # не задана — по факту (28.10): сколько участок сдаёт в рабочий день
        for code, v in fact_capacities(db).items():
            out.setdefault(code, v)
    return out


def resolve_task_site(
    task_area: str | None,
    lam_area: str | None = None,
    area_map: dict | None = None,
    site_map: dict | None = None,
    db: Session | None = None,
) -> tuple[int, str]:
    """Определяет площадку задания (Северный или Фабрика).
    Если задание — панель под ламинацию (lam_area), целевой площадкой
    становится площадка участка ламинации."""
    target_area = lam_area or task_area
    if target_area:
        a = None
        if area_map:
            a = area_map.get(target_area)
        elif db:
            a = db.get(Area, target_area)
        if a and a.site_id:
            if site_map and a.site_id in site_map:
                s = site_map[a.site_id]
                return s.id, s.name
            if db:
                from app.models.sites import Site
                s = db.get(Site, a.site_id)
                if s:
                    return s.id, s.name
            if a.site_id == 2:
                return 2, "Фабрика"
            if a.site_id == 1:
                return 1, "Северный"
    if target_area in (
        "fabrika",
        "frezerovka_laminirovannykh_paneley",
        "frezerovka_perimetra_shchitov",
        "frezerovka_pod_zamok",
    ):
        return 2, "Фабрика"
    return 1, "Северный"


FACT_DAYS = 28


def fact_capacities(db: Session, today: date | None = None) -> dict[str, float]:
    """Мощность по факту (28.10): годные + брак по отчётам за последние 4
    недели, делённые на рабочие дни — от начала окна или от первого отчёта
    участка, если он позже (участок начал отчитываться недавно). Для участков
    производства п/ф (skleyka_mdf_s_zagotovkoy и др.) также учитывается
    выпуск партий PartUnit по первому этапу детали (PartStage sequence_order=1).
    Кэш на запрос."""
    if "fact_caps" in db.info:
        return db.info["fact_caps"]
    from sqlalchemy import func

    from app.models.dictionaries import PartStage
    from app.models.part_units import PartUnit
    from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
    from app.services.planning import load_calendar, workdays_between

    load_calendar(db)
    today = today or date.today()
    start = today - timedelta(days=FACT_DAYS)
    out: dict[str, float] = {}
    for area, pieces, first in (
        db.query(
            ProductionTask.area,
            func.sum(ProductionTaskLineReport.good_pieces + ProductionTaskLineReport.defect_pieces),
            func.min(ProductionTaskLineReport.reported_at),
        )
        .join(ProductionTaskLine, ProductionTaskLine.id == ProductionTaskLineReport.task_line_id)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTaskLineReport.reported_at >= start, ProductionTaskLineReport.counts_toward_line.is_(True))
        .group_by(ProductionTask.area)
    ):
        if not pieces:
            continue
        days = max(1, workdays_between(max(start, first.date()) - timedelta(days=1), today))
        out[area] = round(float(pieces) / days, 1)

    # Участки полуфабрикатов (нарезка, склейка, каркасы) выпускают PartUnit:
    stage1_sub = (
        db.query(PartStage.part_id, PartStage.area.label("s1_area"))
        .filter(PartStage.sequence_order == 1, PartStage.area.isnot(None))
        .subquery()
    )
    for area, pieces, first in (
        db.query(
            stage1_sub.c.s1_area,
            func.sum(PartUnit.quantity_pieces),
            func.min(PartUnit.manufactured_at),
        )
        .join(stage1_sub, stage1_sub.c.part_id == PartUnit.part_id)
        .filter(PartUnit.manufactured_at >= start)
        .group_by(stage1_sub.c.s1_area)
    ):
        if not pieces:
            continue
        days = max(1, workdays_between(max(start, first) - timedelta(days=1), today))
        part_cap = round(float(pieces) / days, 1)
        out[area] = max(out.get(area, 0.0), part_cap)

    db.info["fact_caps"] = out
    return out
