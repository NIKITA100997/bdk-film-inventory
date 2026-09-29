"""Плёнка под панели заказанных дверей (щитовые): ламинация панелей идёт
операцией без плёнки в строке задания, поэтому в резерв «Закупок» она сама
не попадала. Здесь — по закреплённой за панелью плёнке:

  панелей к ламинации = нужно по открытым заказам и заданиям (потребность
                        п/ф по детали) − уже ламинированные на остатке;
  плёнки, м²          = панелей × длина × ширина плёнки (штрипс детали, а
                        если не задан — ширина панели).

Панель без закреплённой плёнки (ПЭТ 2Д/3Д, разная толщина) в резерв не
идёт — показывается отдельно, чтобы плёнку выбрали у детали."""

from collections import defaultdict
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.dictionaries import Part
from app.models.part_units import PartUnit, PartUnitStatus
from app.services.part_units import reported_good_pieces_by_unit
from app.services.pf_demand import compute_pf_demand

LAMINATION = ("Ламинация", "Окутка")
# Широкоформатная окутка панелей на Фабрике — плёнка шире панели на 7 мм
# (617 / 817 / 917 при панели 610 / 810 / 910), решение пользователя 29.09.
# На мембранно-вакуумных прессах плёнку режут в размер вручную — по ширине
# панели, пока не решено иначе.
FACTORY_SITE = "Фабрика"
FACTORY_WRAP_ALLOWANCE_MM = 7


@dataclass
class PanelFilmRow:
    part_id: int
    part_name: str
    need_pieces: float  # по открытым заказам и заданиям
    laminated: float  # уже ламинированы, на остатке
    to_laminate: float
    film_width_mm: float
    film_width_from_part: bool  # задан штрипс у детали
    width_rule: str  # откуда ширина плёнки — для подписи
    length_m: float
    area_m2: float
    film: str | None  # закреплённая плёнка
    group: tuple[int, int, int] | None  # материал, цвет, толщина


def _film_width(db: Session, part: Part, stage) -> tuple[float, str]:
    """Ширина плёнки на панель: штрипс детали; иначе по площадке операции —
    Фабрика (широкоформатная окутка) +7 мм, прессы — в размер панели."""
    from app.models.areas import Area
    from app.models.sites import Site

    if part.strip_width_mm:
        return float(part.strip_width_mm), "штрипс детали"
    width = float(part.width_mm or 0)
    area = db.get(Area, stage.area) if stage.area else None
    site = db.get(Site, area.site_id) if area is not None and area.site_id else None
    if site is not None and site.name == FACTORY_SITE:
        return width + FACTORY_WRAP_ALLOWANCE_MM, f"ширина панели + {FACTORY_WRAP_ALLOWANCE_MM} мм (окутка, Фабрика)"
    return width, "ширина панели (прессы — режут в размер)"


def _exploded_demand(db: Session) -> dict[int, float]:
    """Потребность по деталям с разворотом вглубь (как MRP): нужно детали
    сверх её остатка и запущенного в работу — нужно и её комплектующим п/ф
    по составу (панель с узором → ламинированная панель). Запущенное уже
    учтено потребностью п/ф от строк-операций, поэтому вычитается."""
    from app.models.items import ItemComponent

    rows = {r.part_id: r for r in compute_pf_demand(db)}
    need: dict[int, float] = defaultdict(float)
    for pid, r in rows.items():
        need[pid] += r.task_demand
    parts = {p.item_id: p for p in db.query(Part).filter(Part.is_active.is_(True)) if p.item_id}
    frontier = [pid for pid, v in need.items() if v > 0]
    for _ in range(6):
        nxt: list[int] = []
        for pid in frontier:
            part = db.get(Part, pid)
            r = rows.get(pid)
            covered = (r.stock + r.in_work) if r else 0.0
            net = max(0.0, need[pid] - covered)
            if net <= 0 or part is None or part.item_id is None:
                continue
            for c in db.query(ItemComponent).filter(ItemComponent.parent_item_id == part.item_id):
                child = parts.get(c.component_item_id)
                if child is None:
                    continue
                need[child.id] += net * float(c.qty_per_unit)
                nxt.append(child.id)
        if not nxt:
            break
        frontier = list(dict.fromkeys(nxt))
    return {k: v for k, v in need.items() if v > 0}


def panel_film_demand(db: Session) -> list[PanelFilmRow]:
    demand = _exploded_demand(db)
    if not demand:
        return []
    out: list[PanelFilmRow] = []
    for part in db.query(Part).filter(Part.id.in_(list(demand)), Part.is_active.is_(True)):
        stages = sorted(part.stages, key=lambda s: s.sequence_order)
        lam = next((s for s in stages if s.name in LAMINATION), None)
        if lam is None:
            continue
        after = {s.id for s in stages if s.sequence_order > lam.sequence_order}
        units = (
            db.query(PartUnit)
            .filter(
                PartUnit.part_id == part.id,
                PartUnit.stage_id.in_(after or {-1}),
                PartUnit.status.in_([PartUnitStatus.NA_KHRANENII, PartUnitStatus.VYDAN_UCHASTKU]),
            )
            .all()
        )
        reported = reported_good_pieces_by_unit(db, [u.id for u in units])
        laminated = sum(max(0.0, float(u.quantity_pieces) - reported.get(u.id, 0.0)) for u in units)
        to_laminate = max(0.0, demand[part.id] - laminated)
        width, rule = _film_width(db, part, lam)
        length = float(part.length_m or 0)
        sku = part.default_material_sku
        out.append(
            PanelFilmRow(
                part_id=part.id, part_name=part.name, need_pieces=round(demand[part.id], 2), laminated=round(laminated, 2),
                to_laminate=round(to_laminate, 2), film_width_mm=width, film_width_from_part=bool(part.strip_width_mm),
                width_rule=rule,
                length_m=length, area_m2=round(to_laminate * length * width / 1000, 3),
                film=(
                    f"{sku.material.name}, {sku.color.name}, {float(sku.thickness.value_mm):g} мм, {sku.manufacturer.name}"
                    if sku is not None
                    else None
                ),
                group=(sku.material_id, sku.color_id, sku.thickness_id) if sku is not None else None,
            )
        )
    return sorted(out, key=lambda r: (r.film is not None, -r.area_m2, r.part_name))


def panel_film_by_group(rows: list[PanelFilmRow]) -> dict[tuple[int, int, int], float]:
    totals: dict[tuple[int, int, int], float] = defaultdict(float)
    for r in rows:
        if r.group is not None and r.area_m2 > 0:
            totals[r.group] += r.area_m2
    return {k: round(v, 3) for k, v in totals.items()}
