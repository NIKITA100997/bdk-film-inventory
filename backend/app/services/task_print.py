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


def print_sheets(db: Session, tasks: list[ProductionTask]) -> list[dict]:
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
    for t in sorted(tasks, key=lambda t: t.id):
        area = db.get(Area, t.area)
        site = db.get(Site, area.site_id) if area is not None and area.site_id else None
        sheet = by_area.setdefault(t.area, {
            "area": t.area, "area_name": area.name if area else t.area, "site": site.name if site else None,
            "tasks": [], "rows": [],
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
            })
    out = list(by_area.values())
    for s in out:
        s["rows"].sort(key=lambda r: (r["date_from"] or "9999", r["name"]))
        s["total"] = round(sum(r["qty"] for r in s["rows"]), 2)
    return sorted(out, key=lambda s: (min((r["date_from"] or "9999") for r in s["rows"]) if s["rows"] else "9999", s["area_name"]))
