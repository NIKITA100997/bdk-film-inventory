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
from app.services.operation_roles import film_stage, suggest_area
from app.services.pf_demand import compute_pf_demand

# Операция с плёнкой — по виду операции (services/operation_roles), не по
# названию. Припуск плёнки (Фабрика: панель + 7 мм, решение 29.09) и
# «крупные партии — на Фабрику» (от 200 панелей) — настройки участка (03.10).


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


def _planned_area(db: Session, stage, to_laminate: float) -> str | None:
    """Где будут ламинировать: по открытым заданиям на эту операцию (больше
    штук — та площадка), а если заданий нет — по размеру партии."""
    from sqlalchemy import func

    from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport

    lines = (
        db.query(ProductionTaskLine, ProductionTask.area)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTask.is_active.is_(True), ProductionTaskLine.part_stage_id == stage.id)
        .all()
    )
    by_area: dict[str, float] = defaultdict(float)
    for line, area in lines:
        good = float(
            db.query(func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
            .filter(ProductionTaskLineReport.task_line_id == line.id)
            .scalar()
        )
        by_area[area] += max(0.0, float(line.quantity_pieces) - good)
    if by_area and max(by_area.values()) > 0:
        return max(by_area.items(), key=lambda kv: kv[1])[0]
    return suggest_area(db, stage.area, to_laminate)


def _film_width(db: Session, part: Part, stage, area_code: str | None = None) -> tuple[float, str]:
    """Ширина плёнки на панель: штрипс детали; иначе ширина панели плюс
    припуск участка (Фабрика, широкоформатная окутка, — 7 мм)."""
    from app.models.areas import Area

    if part.strip_width_mm:
        return float(part.strip_width_mm), "штрипс детали"
    width = float(part.width_mm or 0)
    code = area_code or stage.area
    area = db.get(Area, code) if code else None
    allowance = float(area.film_allowance_mm or 0) if area is not None else 0.0
    if allowance:
        return width + allowance, f"ширина панели + {allowance:g} мм (припуск участка «{area.name}»)"
    if area is not None and area.film_cut_on_site:
        return width, "ширина панели (плёнку режут на участке)"
    return width, "ширина панели"


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
        lam = film_stage(stages)
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
        # Строки ламинации с плёнкой (с 02.10) резервируются как обычные
        # строки заданий — здесь их не считаем второй раз.
        to_laminate = max(0.0, demand[part.id] - laminated - _in_film_lines(db, lam))
        width, rule = _film_width(db, part, lam, _planned_area(db, lam, to_laminate))
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


def _in_film_lines(db: Session, stage) -> float:
    """Осталось сделать по открытым строкам ламинации этой детали, у которых
    плёнка в строке уже есть (они в резерве «Закупок» сами по себе)."""
    from sqlalchemy import func

    from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport

    total = 0.0
    for line in (
        db.query(ProductionTaskLine)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(
            ProductionTask.is_active.is_(True), ProductionTaskLine.part_stage_id == stage.id,
            ProductionTaskLine.material_id.isnot(None), ProductionTaskLine.is_closed.is_(False),
        )
    ):
        good = float(
            db.query(func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
            .filter(ProductionTaskLineReport.task_line_id == line.id, ProductionTaskLineReport.counts_toward_line.is_(True))
            .scalar()
        )
        total += max(0.0, float(line.quantity_pieces) - good)
    return total


def panel_film_by_group(rows: list[PanelFilmRow]) -> dict[tuple[int, int, int], float]:
    totals: dict[tuple[int, int, int], float] = defaultdict(float)
    for r in rows:
        if r.group is not None and r.area_m2 > 0:
            totals[r.group] += r.area_m2
    return {k: round(v, 3) for k, v in totals.items()}


def panel_film_spec(db: Session, part: Part) -> tuple[int, int, int] | None:
    """Плёнка для строки ламинации/окутки панели (материал, цвет, толщина):
    закреплённая у детали, иначе по цвету позиции — варианты «Цвет» с
    привязкой к плёнке; ПЭТ 2Д/3Д решается признаком ПЭТ у позиции детали.
    Производитель строке задания не нужен — несколько производителей одной
    плёнки не мешают. Не определилась однозначно — None (плёнку выбирают
    в задании)."""
    from app.models.dictionaries import MaterialSku
    from app.models.items import Item
    from app.services import type_rules
    from app.services.film_check import pet_of_material

    if part.default_material_sku_id:
        s = db.get(MaterialSku, part.default_material_sku_id)
        return (s.material_id, s.color_id, s.thickness_id) if s else None
    item = db.get(Item, part.item_id) if part.item_id else None
    color = type_rules.item_values_color(db, item) if item is not None else None
    if not color:
        return None
    cands = type_rules.film_candidates(db, color)
    if len({(s.material_id, s.color_id, s.thickness_id) for s in cands}) > 1:
        pet = (item.pet_type or "2d") if item is not None else "2d"
        pets = [pet_of_material(s.material.name) for s in cands]
        if any(p is not None for p in pets):
            cands = [s for s, p in zip(cands, pets) if p is None or p == pet]
    specs = {(s.material_id, s.color_id, s.thickness_id) for s in cands}
    return specs.pop() if len(specs) == 1 else None


def lamination_line_film(db: Session, part: Part, stage, area_code: str | None) -> dict:
    """Поля плёнки для строки задания на ламинацию/окутку панели: плёнка,
    длина на штуку, ширина штрипса — панель + припуск участка (режет склад,
    как обычная окутка), на участке, где плёнку режут сами, — без штрипса."""
    from app.services.areas import cuts_film_on_site

    out: dict = {"length_m": float(part.length_m or 0)}
    spec = panel_film_spec(db, part)
    if spec is not None:
        out.update(material_id=spec[0], color_id=spec[1], thickness_id=spec[2])
    if not cuts_film_on_site(db, area_code):
        out["strip_width_mm"] = _film_width(db, part, stage, area_code)[0]
    return out
