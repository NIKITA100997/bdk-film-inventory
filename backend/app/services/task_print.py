"""Печать заданий по участкам (02.10): пакетом — лист на участок, на нём
строки всех выбранных заданий этого участка: что делать (характеристики
изделия), счёт, сколько, плёнка/штрипс, программа станка, указание мастеру,
срок по плану. Графы «Сделано / Брак / Подпись» мастер заполняет от руки.
Сам лист собирает браузер (печать на обычный принтер)."""

from collections import defaultdict

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.dictionaries import Color, Material, Thickness
from app.models.production import PlanSlot, ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.production_orders import ProductionOrder, ProductionOrderLine
from app.models.sites import Site
from app.services.type_rules import item_chars_cached


def _panel_info(db: Session, ln: ProductionTaskLine, ol, cache: dict) -> dict | None:
    """Панель щитовой двери (07.10, ведомость фрезеровки как в Excel): МДФ,
    шлифовка или цвет (у ПЭТ на Kastamonu), модель, размер заготовки
    толщиной вперёд. Не панель — None."""
    from app.models.dictionaries import Part, PartStage
    from app.models.items import Item, ItemPropertyOption
    from app.services import type_rules

    if not ln.part_id:
        return None
    key = (ln.part_id, ln.task.production_order_id)
    if key in cache:
        return cache[key]
    part = db.get(Part, ln.part_id)
    item = db.get(Item, part.item_id) if part is not None and part.item_id else None
    info = None
    codes = {p.code for p in item.type.properties} if item is not None and item.type is not None else set()
    if {"толщина", "ширина", "высота"} <= codes and codes & {"мдф", "пэт"}:
        vals = type_rules.item_values(db, item)
        by = {}
        for p in item.type.properties:
            v = vals.get(p.id)
            by[p.code] = db.get(ItemPropertyOption, v).value if (p.value_type == "list" and v) else v
        if by.get("толщина") and by.get("ширина") and by.get("высота"):
            # ПЭТ-ветка панели с узором — всегда Kastamonu (ответ 07.10)
            kast = by.get("мдф") == "Kastamonu" or bool(by.get("пэт"))
            if kast:
                color = by.get("цвет") or next((c["value"] for c in (item_chars_cached(db, ol.item_id) if ol else []) if c["code"] == "цвет"), "")
                sand = color or "—"
            else:
                sanded = (
                    db.query(ProductionTaskLine.id)
                    .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
                    .join(PartStage, PartStage.id == ProductionTaskLine.part_stage_id)
                    .filter(ProductionTask.production_order_id == ln.task.production_order_id, ProductionTaskLine.part_id == ln.part_id,
                            PartStage.name.ilike("%шлиф%"))
                    .first()
                )
                sand = "ДА" if sanded else "НЕТ"
            info = {
                "mdf": "Каст." if kast else ("Бел." if by.get("мдф") else ""),
                "sand": sand,
                "series": by.get("серия") or "",
                "blank": f"{float(by['толщина']):g}х{float(by['ширина']):g}х{float(by['высота']):g}",
            }
    cache[key] = info
    return info


def _cut_comment(name: str) -> str | None:
    """Деталь каркаса пилят толще и вышлифовывают (07.10): целая толщина —
    +1 мм, дробная — +1,5 мм. «Стойка каркаса 24х50х2010» → «Пилим 25 мм /
    шлифуем 24 мм»."""
    import re

    if "каркас" not in name.lower():
        return None
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*х", name)
    if not m:
        return None
    t = float(m.group(1).replace(",", "."))
    cut = t + (1 if t == int(t) else 1.5)
    f = lambda v: f"{v:g}".replace(".", ",")  # noqa: E731
    return f"Пилим {f(cut)} мм / шлифуем {f(t)} мм"


def _components(db: Session, ln: ProductionTaskLine) -> list[tuple[str, float]]:
    """Комплектующие без своего маршрута, которые расходуются на этой строке
    (детали каркаса на сборке): (название, всего на строку)."""
    from app.models.dictionaries import Part
    from app.models.items import Item, ItemComponent

    part = db.get(Part, ln.part_id) if ln.part_id else None
    if part is None or not part.item_id:
        return []
    out = []
    for c in db.query(ItemComponent).filter(ItemComponent.parent_item_id == part.item_id):
        ci = db.get(Item, c.component_item_id)
        if ci is None or ci.stages or ci.kind.code != "pf":
            continue
        out.append((ci.name, float(c.qty_per_unit) * float(ln.quantity_pieces)))
    return out


def print_sheets(db: Session, tasks: list[ProductionTask]) -> list[dict]:
    from app.services.line_groups import line_group

    lines = [ln for t in tasks for ln in t.lines]
    ids = [ln.id for ln in lines]
    good: dict[int, float] = {}
    slots: dict[int, list] = defaultdict(list)
    if ids:
        good = {
            lid: float(g)
            for lid, g in db.query(ProductionTaskLineReport.task_line_id, func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
            .filter(ProductionTaskLineReport.task_line_id.in_(ids), ProductionTaskLineReport.counts_toward_line.is_(True))
            .group_by(ProductionTaskLineReport.task_line_id)
        }
        for s in db.query(PlanSlot).filter(PlanSlot.task_line_id.in_(ids)):
            slots[s.task_line_id].append(s.date)
    mats = {m.id: m.name for m in db.query(Material)}
    cols = {c.id: c.name for c in db.query(Color)}
    ths = {t.id: float(t.value_mm) for t in db.query(Thickness)}
    by_area: dict[str, dict] = {}
    panel_cache: dict = {}
    for t in sorted(tasks, key=lambda t: t.id):
        area = db.get(Area, t.area)
        site = db.get(Site, area.site_id) if area is not None and area.site_id else None
        sheet = by_area.setdefault(t.area, {
            "area": t.area, "area_name": area.name if area else t.area, "site": site.name if site else None,
            "tasks": [], "rows": [], "components": {}, "groups": {},
        })
        order = db.get(ProductionOrder, t.production_order_id) if t.production_order_id else None
        sheet["tasks"].append({
            "id": t.id, "name": t.name,
            "order": f"№{order.id} «{order.name}»" if order else None,
            "ship_date": order.ship_date.isoformat() if order and order.ship_date else None,
        })
        for ln in t.lines:
            if ln.production_closed:
                continue
            ol = db.get(ProductionOrderLine, ln.order_line_id) if ln.order_line_id else None
            days = sorted(slots.get(ln.id, []))
            film = None
            if ln.material_id:
                film = f"{mats.get(ln.material_id, '')} {cols.get(ln.color_id, '')} {ths.get(ln.thickness_id, 0):g}".strip()
                film += f" · штрипс {float(ln.strip_width_mm):g} мм" if ln.strip_width_mm else " · рулон"
            sheet["rows"].append({
                "task_id": t.id,
                "name": ln.part_name or "",
                "chars": [] if ln.part_id else (item_chars_cached(db, ol.item_id) if ol else []),
                "invoice_no": ol.invoice_no if ol else None,
                "qty": float(ln.quantity_pieces),
                "done": round(min(good.get(ln.id, 0.0), float(ln.quantity_pieces)), 2),
                "film": film,
                "program": ln.program,
                "instruction": ln.instruction,
                "date_from": days[0].isoformat() if days else None,
                "date_to": days[-1].isoformat() if days else None,
                "panel": _panel_info(db, ln, ol, panel_cache),
            })
            # группа участка (08.10, services/line_groups.py)
            grp = line_group(db, ln, t.area, [] if ln.part_id else (item_chars_cached(db, ol.item_id) if ol else []))
            if grp is not None:
                gk, gl = grp
                g = sheet["groups"].setdefault(gk, {"label": gl, "qty": 0.0, "done": 0.0, "lines": 0, "invoices": set(), "date_from": None, "date_to": None})
                g["qty"] += float(ln.quantity_pieces)
                g["done"] += min(good.get(ln.id, 0.0), float(ln.quantity_pieces))
                g["lines"] += 1
                if ol is not None and ol.invoice_no:
                    g["invoices"].add(ol.invoice_no)
                if days:
                    g["date_from"] = min(filter(None, [g["date_from"], days[0].isoformat()]))
                    g["date_to"] = max(filter(None, [g["date_to"], days[-1].isoformat()]))
            for name, qty in _components(db, ln):
                sheet["components"][name] = sheet["components"].get(name, 0.0) + qty
    out = list(by_area.values())
    for s in out:
        s["rows"].sort(key=lambda r: (r["date_from"] or "9999", r["name"]))
        s["total"] = round(sum(r["qty"] for r in s["rows"]), 2)
        s["groups"] = [
            {**g, "qty": round(g["qty"], 2), "done": round(g["done"], 2), "invoices": sorted(g["invoices"])}
            for g in sorted(s["groups"].values(), key=lambda g: g["label"])
        ]
        s["components"] = [
            {"name": n, "qty": round(q, 2), "comment": _cut_comment(n)} for n, q in sorted(s["components"].items())
        ]
    return sorted(out, key=lambda s: (min((r["date_from"] or "9999") for r in s["rows"]) if s["rows"] else "9999", s["area_name"]))
