"""Раскладка запуска (02.10): перед запуском заказа — что родится по
участкам, как листы Excel-монитора («Каркас», «Распил», «Окутка»,
«Склейка»…), с количеством, сроками, плёнкой и предупреждениями.

Считается настоящим запуском (release_order + release_pf + schedule_order —
те же функции, что у кнопки «Запустить»), который вызывающий код потом
откатывает: показ совпадает с тем, что родится, а не отдельный
приблизительный расчёт. Здесь ничего не коммитится."""

from collections import defaultdict

from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.dictionaries import MaterialSku, Part, PartStage
from app.models.items import Item, ItemComponent
from app.models.production import PlanSlot, ProductionTask
from app.models.production_orders import ProductionOrder
from app.models.units import MaterialUnit, UnitStatus
from app.services import type_rules
from app.services.areas import cuts_film_on_site
from app.services.components import live_item_names, planned_components
from app.services.operation_roles import is_film, needs_program
from app.services.planning import PfPick, release_pf, schedule_order
from app.services.production_orders import release_order
from app.services.warehouses import area_home_warehouse_id, filter_by_warehouse

STANDARD_WIDTHS = {600, 700, 800, 900}
STANDARD_HEIGHT = 2000


def _film_stock_m(db: Session, area: str, spec: tuple[int, int, int], min_width: float) -> float:
    """Метры этой плёнки на складе площадки участка — рулоны и штрипсы не уже
    нужной ширины (из более широкого склад нарежет)."""
    sku_ids = [
        s.id for s in db.query(MaterialSku).filter(
            MaterialSku.material_id == spec[0], MaterialSku.color_id == spec[1], MaterialSku.thickness_id == spec[2],
        )
    ]
    if not sku_ids:
        return 0.0
    q = db.query(MaterialUnit).filter(
        MaterialUnit.status == UnitStatus.NA_KHRANENII, MaterialUnit.material_sku_id.in_(sku_ids),
        MaterialUnit.width_mm >= min_width - 0.5,
    )
    q = filter_by_warehouse(q, MaterialUnit.location_code, db, area_home_warehouse_id(db, area))
    return round(sum(float(u.length_m) for u in q), 1)


def build_release_layout(
    db: Session, order: ProductionOrder, picks: list[PfPick], user_id: int, overrides=None, user_name: str = "",
    area_dates: dict | None = None, shift_days: int = 0, shift_next: bool = True,
) -> dict:
    """Запустить заказ (без commit) и описать результат. Вызывающий код
    обязан сделать db.rollback()."""
    from app.services.release_overrides import apply_overrides, line_key

    tasks = release_order(db, order, user_id)
    release_pf(db, order, tasks, picks, user_id)
    override_errors = apply_overrides(db, order, overrides or [], user_name)
    sched = schedule_order(db, order, user_id)
    if area_dates or shift_days:
        from app.services.planning import apply_release_dates, order_plan_status

        apply_release_dates(db, order, area_dates or {}, shift_days, user_id, shift_next)
        sched = order_plan_status(db, order)
    db.flush()

    areas = {a.code: a for a in db.query(Area)}
    lines_by_id = {l.id: l for l in order.lines}
    items = {l.id: db.get(Item, l.item_id) for l in order.lines}
    chars_cache: dict[int, list] = {}

    def chars(item: Item | None) -> list:
        if item is None:
            return []
        if item.id not in chars_cache:
            chars_cache[item.id] = type_rules.item_chars(db, item)
        return chars_cache[item.id]

    sheets: dict[str, dict] = {}
    warnings: list[str] = list(override_errors)
    programmed: dict[int, bool] = {}
    milled_lines: set[int] = set()
    film_need: dict[tuple, dict] = {}
    for t in db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id).order_by(ProductionTask.id):
        area = areas.get(t.area)
        sheet = sheets.setdefault(t.area, {
            "area": t.area, "name": area.name if area else t.area, "pf": t.for_task_id is not None,
            "cut_on_site": bool(area and area.film_cut_on_site), "rows": [], "dates": set(),
        })
        for ln in t.lines:
            stage = db.get(PartStage, ln.part_stage_id) if ln.part_stage_id else None
            if needs_program(stage) and ln.order_line_id:
                milled_lines.add(ln.order_line_id)
                programmed[ln.order_line_id] = programmed.get(ln.order_line_id, True) and bool(ln.program)
            dates = sorted({s.date for s in db.query(PlanSlot).filter(PlanSlot.task_line_id == ln.id)})
            sheet["dates"].update(dates)
            part = db.get(Part, ln.part_id) if ln.part_id else None
            item = db.get(Item, part.item_id) if part is not None and part.item_id else items.get(ln.order_line_id)
            ol = lines_by_id.get(ln.order_line_id)
            row = {
                "key": line_key(ln),
                "area": t.area,
                "program": ln.program,
                "instruction": ln.instruction,
                "manual": bool(ln.manual_changes),
                "name": ln.part_name or (item.name if item else ""),
                "qty": float(ln.quantity_pieces),
                "chars": chars(item),
                "door": items[ln.order_line_id].name if ln.part_id and ln.order_line_id in items else None,
                "note": ol.note if ol is not None else None,
                "date_from": dates[0].isoformat() if dates else None,
                "date_to": dates[-1].isoformat() if dates else None,
                "film": None,
            }
            if ln.material_id:
                sku = db.query(MaterialSku).filter(
                    MaterialSku.material_id == ln.material_id, MaterialSku.color_id == ln.color_id,
                    MaterialSku.thickness_id == ln.thickness_id,
                ).first()
                need_m = round(float(ln.quantity_pieces) * float(ln.length_m or 0), 1)
                width = float(ln.strip_width_mm or ln.width_mm or 0)
                row["film"] = {
                    "sku_id": sku.id if sku else None,
                    "label": f"{sku.material.name} {sku.color.name} {float(sku.thickness.value_mm):g}" if sku else "?",
                    "strip_width_mm": float(ln.strip_width_mm) if ln.strip_width_mm is not None else None,
                    "width_mm": width, "need_m": need_m,
                }
                key = (t.area, ln.material_id, ln.color_id, ln.thickness_id)
                g = film_need.setdefault(key, {"label": row["film"]["label"], "need_m": 0.0, "min_width": 0.0, "area": t.area})
                g["need_m"] += need_m
                # прессы: один рулон на все — не уже самой широкой детали;
                # Фабрика: штрипсы режут из рулона — годится всё не уже самого узкого
                if cuts_film_on_site(db, t.area):
                    g["min_width"] = max(g["min_width"], width)
                else:
                    g["min_width"] = min(g["min_width"], width) if g["min_width"] else width
            elif is_film(stage):
                warnings.append(f"Плёнка не определена: {ln.part_name} ({sheet['name']}) — выберите плёнку у цвета или детали")
            sheet["rows"].append(row)

    # плёнка: хватает ли на складе площадки
    film = []
    for (area, *_spec), g in film_need.items():
        spec = tuple(_spec)
        stock = _film_stock_m(db, area, spec, g["min_width"])
        film.append({"area": area, "area_name": sheets[area]["name"], "label": g["label"], "need_m": round(g["need_m"], 1),
                     "stock_m": stock, "min_width_mm": g["min_width"], "cut_on_site": sheets[area]["cut_on_site"]})
        if stock + 0.05 < g["need_m"]:
            warnings.append(f"Не хватает плёнки {g['label']} на {sheets[area]['name']}: нужно {g['need_m']:.0f} м, "
                            f"на складе {stock:.0f} м (не уже {g['min_width']:g} мм)")

    # нестандартный размер у дверей с фрезеровкой панелей — программа у конструктора
    for lid in sorted(milled_lines):
        ch = {c["code"]: c["value"] for c in chars(items.get(lid))}
        try:
            w, h = float(ch.get("ширина", "0").split()[0]), float(ch.get("высота", "0").split()[0])
        except ValueError:
            continue
        if (int(w) not in STANDARD_WIDTHS or int(h) != STANDARD_HEIGHT) and not programmed.get(lid):
            warnings.append(f"Нестандартный размер {w:g}х{h:g} — программу фрезеровки делает конструктор: {items[lid].name}")

    # материалы и комплектующие по составу (без своего маршрута — не задания)
    totals: dict[str, float] = defaultdict(float)
    units: dict[str, str | None] = {}

    def walk(item_id: int, k: float, depth: int = 0) -> None:
        comps = planned_components(db.query(ItemComponent).filter(ItemComponent.parent_item_id == item_id).all())
        names = live_item_names(db, {c.component_item_id for c in comps})
        for c in comps:
            q = float(c.qty_per_unit) * k
            part = db.query(Part).filter(Part.item_id == c.component_item_id).first()
            if part is None or not part.stages:
                nm = names.get(c.component_item_id) or "?"
                totals[nm] += q
                it = db.get(Item, c.component_item_id)
                units[nm] = it.unit if it else None
            if depth < 4:
                walk(c.component_item_id, q, depth + 1)

    for l in order.lines:
        walk(l.item_id, float(l.quantity))
    materials = [{"name": n, "qty": round(q, 3), "unit": units.get(n)} for n, q in sorted(totals.items())]

    seq = []
    for s in sheets.values():
        d = sorted(s.pop("dates"))
        s["date_from"] = d[0].isoformat() if d else None
        s["date_to"] = d[-1].isoformat() if d else None
        s["total"] = round(sum(r["qty"] for r in s["rows"]), 2)
        seq.append(s)
    seq.sort(key=lambda s: (s["date_from"] or "9999", s["name"]))
    return {
        "sheets": seq,
        "film": sorted(film, key=lambda f: (f["area_name"], f["label"])),
        "materials": materials,
        "warnings": warnings,
        "finish": sched.finish.isoformat() if sched.finish else None,
        "late": bool(sched.late),
        "doors": float(sum(float(l.quantity) for l in order.lines)),
    }
