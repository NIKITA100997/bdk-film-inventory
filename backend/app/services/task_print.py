"""Печать заданий по участкам (02.10): пакетом — лист на участок, на нём
строки всех выбранных заданий этого участка: что делать (характеристики
изделия), счёт, сколько, плёнка/штрипс, программа станка, указание мастеру,
срок по плану. Графы «Сделано / Брак / Подпись» мастер заполняет от руки.
Сам лист собирает браузер (печать на обычный принтер)."""

from collections import defaultdict
import re

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.dictionaries import Color, Material, Thickness
from app.models.production import PlanSlot, ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.production_orders import ProductionOrder, ProductionOrderLine
from app.models.items import Item
from app.models.sites import Site
from app.services.task_line_sources import source_allocations
from app.services.door_cols import door_cols
from app.services.type_rules import item_chars_cached


def _panel_info(db: Session, ln: ProductionTaskLine, ol, cache: dict) -> dict | None:
    """Панель щитовой двери (07.10, ведомость фрезеровки как в Excel): МДФ,
    шлифовка или цвет (у ПЭТ на Kastamonu), модель, размер заготовки
    толщиной вперёд. Не панель — None."""
    from app.models.dictionaries import Part, PartStage
    from app.models.items import Item, ItemPropertyOption
    from app.services import type_rules

    pname = ln.part_name or ""
    pname_low = pname.lower()
    is_panel_line = "панел" in pname_low or "мдф" in pname_low or "накладк" in pname_low
    if not ln.part_id and not is_panel_line:
        return None

    key = (ln.part_id or 0, ln.task.production_order_id if ln.task else 0, pname)
    if key in cache:
        return cache[key]

    part = db.get(Part, ln.part_id) if ln.part_id else None
    item = db.get(Item, part.item_id) if part is not None and part.item_id else None
    by = {}
    if item is not None and item.type is not None:
        vals = type_rules.item_values(db, item)
        for p in item.type.properties:
            v = vals.get(p.id)
            by[p.code] = db.get(ItemPropertyOption, v).value if (p.value_type == "list" and v) else v

    # 1. Производитель МДФ (Kastamonu, Беларусь, МДФ)
    mdf = str(by.get("мдф") or "").strip()
    if not mdf:
        if "kasta" in pname_low or "пэт" in pname_low or "pet" in pname_low:
            mdf = "Kastamonu"
        elif "беларус" in pname_low or "пвх" in pname_low or "полипропилен" in pname_low:
            mdf = "Беларусь"
        elif "мдф" in pname_low or is_panel_line:
            mdf = "МДФ"

    # 2. Серия модели (В-10, В-12, В-14, В-19, Е-10 и т.д.)
    series = str(by.get("серия") or "").strip()
    if not series:
        m_ser = re.search(r"([А-ЯA-Z]-\d+)", pname)
        if m_ser:
            series = m_ser.group(1)
        elif ol:
            series = next((c["value"] for c in item_chars_cached(db, ol.item_id) if c["code"] == "серия"), "")
            if not series and ol.source_text:
                m_ser2 = re.search(r"([А-ЯA-Z]-\d+)", ol.source_text)
                if m_ser2:
                    series = m_ser2.group(1)

    # 3. Размер заготовки толщиной вперёд (T x W x H)
    blank = ""
    if by.get("толщина") and by.get("ширина") and by.get("высота"):
        blank = f"{float(by['толщина']):g}х{float(by['ширина']):g}х{float(by['высота']):g}"
    else:
        m_blank = re.search(r"(\d+(?:[.,]\d+)?\s*[хx]\s*\d+\s*[хx]\s*\d+)", pname)
        if m_blank:
            blank = m_blank.group(1).replace(" ", "")

    # 4. Шлифовка или цвет покрытия
    color = str(by.get("цвет") or "").strip()
    if not color:
        m_c = re.search(r"\((?:ПЭТ|ПВХ|Полипропилен)\s+([^,)]+)", pname)
        if m_c:
            color = m_c.group(1).strip()
        elif ol:
            color = next((c["value"] for c in item_chars_cached(db, ol.item_id) if c["code"] == "цвет"), "")

    if color:
        sand = color
    else:
        sanded = False
        if ln.part_id and ln.task and ln.task.production_order_id:
            sanded = bool(
                db.query(ProductionTaskLine.id)
                .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
                .join(PartStage, PartStage.id == ProductionTaskLine.part_stage_id)
                .filter(
                    ProductionTask.production_order_id == ln.task.production_order_id,
                    ProductionTaskLine.part_id == ln.part_id,
                    PartStage.name.ilike("%шлиф%"),
                )
                .first()
            )
        if not sanded and "шлиф" in pname_low:
            sanded = True
        sand = "ДА" if sanded else "—"

    if not is_panel_line and not blank and not series:
        cache[key] = None
        return None

    info = {
        "mdf": mdf or "МДФ",
        "sand": sand or "—",
        "series": series or "",
        "blank": blank or "",
    }
    cache[key] = info
    return info


def _cut_comment(name: str) -> str | None:
    """Деталь каркаса пилят толще и вышлифовывают (07.10): целая толщина —
    +1 мм, дробная — +1,5 мм. «Стойка каркаса 24х50х2010» → «Пилим 25 мм /
    шлифуем 24 мм». У пенопласта — указание раскроя в размер."""
    low = name.lower()
    if "пенопласт" in low:
        m_th = re.search(r"(\d+(?:[.,]\d+)?)\s*мм", name)
        th = m_th.group(1) if m_th else ""
        return f"Пенопласт {th} мм: раскрой в размер каркаса (−100 мм по ширине и высоте)"
    if "каркас" in low or "брусок" in low or "поперечина" in low or "стойка" in low:
        m = re.search(r"(\d+(?:[.,]\d+)?)\s*х", name)
        if not m:
            return None
        t = float(m.group(1).replace(",", "."))
        cut = t + (1 if t == int(t) else 1.5)
        f = lambda v: f"{v:g}".replace(".", ",")  # noqa: E731
        return f"Пилим {f(cut)} мм / шлифуем {f(t)} мм"
    return None


def _components(db: Session, ln: ProductionTaskLine) -> list[tuple[str, float]]:
    """Комплектующие и материалы без своего отдельного маршрута, которые расходуются на этой строке:
    детали каркаса на сборке, пенопласт на склейке."""
    from app.models.dictionaries import Part
    from app.models.items import Item, ItemComponent

    part = db.get(Part, ln.part_id) if ln.part_id else None
    item_id = part.item_id if part and part.item_id else None
    if not item_id and ln.order_line_id:
        ol = db.get(ProductionOrderLine, ln.order_line_id)
        if ol and ol.item_id:
            item_id = ol.item_id

    if not item_id:
        return []

    out = []
    for c in db.query(ItemComponent).filter(ItemComponent.parent_item_id == item_id):
        ci = db.get(Item, c.component_item_id)
        if ci is None or ci.stages:
            continue
        if ci.kind and ci.kind.code in ("pf", "material"):
            out.append((ci.name, float(c.qty_per_unit) * float(ln.quantity_pieces)))
    return out


def print_sheets(db: Session, tasks: list[ProductionTask]) -> list[dict]:
    from app.services.line_groups import line_group

    lines = [ln for t in tasks for ln in t.lines]
    ids = [ln.id for ln in lines]
    allocations = source_allocations(db, lines)
    source_order_line_ids = {ol_id for rows in allocations.values() for ol_id in rows}
    source_order_lines = {
        ol.id: ol for ol in db.query(ProductionOrderLine).filter(ProductionOrderLine.id.in_(source_order_line_ids or {-1}))
    }
    source_items = {
        item.id: item for item in db.query(Item).filter(
            Item.id.in_({ol.item_id for ol in source_order_lines.values() if ol.item_id} or {-1})
        )
    }
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
        # ведомость распила / фрезеровки панелей — отдельно под ламинацию на Фабрике и на Северном (20.10)
        dest = db.get(Area, t.lam_area) if t.lam_area else None
        dest_site = db.get(Site, dest.site_id) if dest is not None and dest.site_id else None
        lam = f" — для ламинации: {dest_site.name if dest_site else (dest.name if dest else t.lam_area)}" if t.lam_area else ""
        sheet = by_area.setdefault(t.area + (f">{t.lam_area}" if t.lam_area else ""), {
            "area": t.area, "area_name": (area.name if area else t.area) + lam, "site": site.name if site else None,
            "tasks": [], "rows": [], "components": {}, "groups": {},
        })
        order = db.get(ProductionOrder, t.production_order_id) if t.production_order_id else None
        sheet["tasks"].append({
            "id": t.id, "name": t.name,
            "order": f"№{order.id} «{order.name}»" if order else None,
            "ship_date": order.ship_date.isoformat() if order and order.ship_date else None,
            # шапка каждого задания (13.10): общий заказ и его комментарий
            "order_note": (order.note or "").strip() or None if order else None,
        })
        for ln in t.lines:
            if ln.production_closed:
                continue
            ol = db.get(ProductionOrderLine, ln.order_line_id) if ln.order_line_id else None
            source_orders = []
            for source_order_line_id, source_qty in sorted(allocations.get(ln.id, {}).items()):
                source_ol = source_order_lines.get(source_order_line_id)
                if source_ol is None:
                    continue
                source_item = source_items.get(source_ol.item_id)
                source_cols = door_cols(
                    item_chars_cached(db, source_ol.item_id) if source_ol.item_id else [],
                    source_ol.source_text,
                    source_item.name if source_item else None,
                )
                source_orders.append({
                    "order_line_id": source_ol.id,
                    "invoice_no": source_ol.invoice_no,
                    "series": source_cols.get("series", ""),
                    "size": source_cols.get("size", ""),
                    "color": source_cols.get("color", ""),
                    "qty": round(source_qty, 2),
                })
            days = sorted(slots.get(ln.id, []))
            film = None
            if ln.material_id:
                film = f"{mats.get(ln.material_id, '')} {cols.get(ln.color_id, '')} {ths.get(ln.thickness_id, 0):g}".strip()
                film += f" · штрипс {float(ln.strip_width_mm):g} мм" if ln.strip_width_mm else " · рулон"

            # Характеристики изделия и детали (подтягиваем размеры и параметры)
            ol_chars = item_chars_cached(db, ol.item_id) if ol and ol.item_id else []
            part_chars = []
            if ln.part_id:
                from app.models.dictionaries import Part
                part_obj = db.get(Part, ln.part_id)
                if part_obj and part_obj.item_id:
                    part_chars = item_chars_cached(db, part_obj.item_id)

            char_map = {c["code"]: c for c in ol_chars}
            char_map.update({c["code"]: c for c in part_chars})
            row_chars = list(char_map.values())

            # Всегда вызываем door_cols с fallback_name для извлечения серий, размеров и кромок
            cols_data = door_cols(row_chars, ol.source_text if ol else None, ln.part_name)
            if source_orders:
                source_series = sorted({src["series"] for src in source_orders if src["series"]})
                if source_series:
                    cols_data["series"] = ", ".join(source_series)

            # Если размер не определился door_cols, подтягиваем из параметров строки или названия
            if not cols_data.get("size"):
                size_from_name = ""
                m_size = re.search(r"(\d+(?:[.,]\d+)?\s*[хx]\s*\d+(?:\s*[хx]\s*\d+)?)", ln.part_name or "")
                if m_size:
                    size_from_name = m_size.group(1).replace(" ", "")
                elif ln.width_mm and float(ln.width_mm) > 0 and ln.length_m and float(ln.length_m) > 0:
                    size_from_name = f"{float(ln.width_mm):g}х{round(float(ln.length_m) * 1000):g}"
                elif ln.strip_width_mm and float(ln.strip_width_mm) > 0:
                    size_from_name = f"штрипс {float(ln.strip_width_mm):g} мм"
                if size_from_name:
                    cols_data["size"] = size_from_name

            if not cols_data.get("color") and ln.color_id and ln.color_id in cols:
                cols_data["color"] = cols[ln.color_id]

            if not cols_data.get("source"):
                cols_data["source"] = ln.part_name or (ol.source_text if ol else "")

            # Склейка щитов: подбор каркаса, панелей и наполнителя
            skleyka = None
            if "склейк" in t.area.lower() or "skleyka" in t.area.lower():
                pname = ln.part_name or (ol.source_text if ol else "")
                m_s = re.search(r"(\d+(?:[.,]\d+)?\s*[хx]\s*\d+)", pname)
                sz = m_s.group(1).replace(" ", "") if m_s else cols_data.get("size", "")
                ser = cols_data.get("series", "")
                frame_spec = ""
                panel_spec = ""
                foam_spec = ""
                if ol and ol.item_id:
                    from app.models.items import ItemComponent, Item
                    for c in db.query(ItemComponent).filter(ItemComponent.parent_item_id == ol.item_id):
                        ci = db.get(Item, c.component_item_id)
                        if ci:
                            if "каркас" in ci.name.lower():
                                frame_spec = ci.name
                            elif "панел" in ci.name.lower():
                                panel_spec = f"2 шт. {ci.name}"
                            elif "пенопласт" in ci.name.lower():
                                foam_spec = ci.name
                if not frame_spec and sz:
                    parts = sz.split("х")
                    if len(parts) == 2:
                        try:
                            w_num, h_num = float(parts[0]), float(parts[1])
                            frame_spec = f"Каркас 24х{w_num+10:g}х{h_num+10:g}"
                            panel_spec = f"2 шт. 6х{w_num+10:g}х{h_num+10:g} ({ser})"
                            foam_spec = f"Пенопласт 23 мм"
                        except ValueError:
                            pass
                skleyka = {
                    "frame": frame_spec,
                    "panels": panel_spec,
                    "foam": foam_spec,
                }

            source_missing = bool(ln.part_id and t.production_order_id and not source_orders)
            sheet["rows"].append({
                "task_id": t.id,
                "name": ln.part_name or "",
                "chars": row_chars,
                **cols_data,
                "invoice_no": ol.invoice_no if ol else ", ".join(sorted({src["invoice_no"] for src in source_orders if src["invoice_no"]})) or None,
                "source_orders": source_orders,
                "source_missing": source_missing,
                "qty": float(ln.quantity_pieces),
                "done": round(min(good.get(ln.id, 0.0), float(ln.quantity_pieces)), 2),
                "film": film,
                "program": ln.program,
                "instruction": ln.instruction,
                "date_from": days[0].isoformat() if days else None,
                "date_to": days[-1].isoformat() if days else None,
                "panel": _panel_info(db, ln, ol, panel_cache),
                "skleyka": skleyka,
            })
            # группа участка (08.10, services/line_groups.py)
            grp = line_group(db, ln, t.area, row_chars)
            if grp is not None:
                gk, gl = grp
                g = sheet["groups"].setdefault(gk, {"label": gl, "qty": 0.0, "done": 0.0, "lines": 0, "invoices": set(), "unresolved": False, "date_from": None, "date_to": None})
                g["qty"] += float(ln.quantity_pieces)
                g["done"] += min(good.get(ln.id, 0.0), float(ln.quantity_pieces))
                g["lines"] += 1
                source_invoices = {src["invoice_no"] for src in source_orders if src["invoice_no"]}
                if source_invoices:
                    g["invoices"].update(source_invoices)
                elif ol is not None and ol.invoice_no:
                    g["invoices"].add(ol.invoice_no)
                g["unresolved"] = g["unresolved"] or source_missing
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
