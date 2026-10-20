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
from app.services.door_cols import door_cols
from app.services.operation_roles import is_film, needs_program


def is_standard(db: Session, item: Item) -> bool | None:
    """Типовое ли изделие по условию его типа; None — условие не задано
    (или не считается — тогда не предупреждаем)."""
    from app.services.expressions import ExpressionError, evaluate_condition

    t = item.type
    if t is None or not t.standard_condition:
        return None
    try:
        return bool(evaluate_condition(t.standard_condition, type_rules.context_from_values(db, t, type_rules.item_values(db, item))))
    except ExpressionError:
        return None
from app.services.planning import PfPick, release_pf, schedule_order
from app.services.production_orders import release_order
from app.services.warehouses import area_home_warehouse_id, filter_by_warehouse



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
    from app.services.milling_programs import fill_programs

    fill_programs(db, order)  # программы фрезеровки — до ручных правок
    skipped: set[str] = set()
    override_errors = apply_overrides(db, order, overrides or [], user_name, keep_skipped=skipped)
    from app.services.release_merge import merge_pf_lines

    merged_keys = merge_pf_lines(db, order, skipped)  # одинаковые строки п/ф — одной (08.10)
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
    from app.models.sites import Site

    site_name = {x.id: x.name for x in db.query(Site)}
    for t in db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id).order_by(ProductionTask.id):
        area = areas.get(t.area)
        # распил / фрезеровка / шлифовка панелей — отдельный лист под
        # ламинацию на Фабрике и на Северном (20.10)
        skey = t.area + (f">{t.lam_area}" if t.lam_area else "")
        dest = areas.get(t.lam_area) if t.lam_area else None
        dest_name = (site_name.get(dest.site_id) if dest is not None and dest.site_id else None) or (dest.name if dest else t.lam_area)
        sheet = sheets.setdefault(skey, {
            "key": skey, "area": t.area, "lam_area": t.lam_area,
            "name": (area.name if area else t.area) + (f" — для ламинации: {dest_name}" if t.lam_area else ""),
            "pf": t.for_task_id is not None,
            "cut_on_site": bool(area and area.film_cut_on_site), "rows": [], "dates": set(),
        })
        for ln in t.lines:
            stage = db.get(PartStage, ln.part_stage_id) if ln.part_stage_id else None
            if line_key(ln) in skipped:
                # «не делать этот этап» — видна серой, в итоги и потребность не идёт
                part = db.get(Part, ln.part_id) if ln.part_id else None
                sheet["rows"].append({
                    "key": line_key(ln), "area": t.area, "program": ln.program, "instruction": ln.instruction, "manual": True,
                    "name": ln.part_name or (part.name if part else ""), "qty": float(ln.quantity_pieces), "chars": [],
                    "door": items[ln.order_line_id].name if ln.order_line_id in items else None, "note": None,
                    "date_from": None, "date_to": None, "film": None, "operation": stage.name if stage is not None else None,
                    "skipped": True,
                })
                continue
            if needs_program(stage) and ln.order_line_id:
                milled_lines.add(ln.order_line_id)
                programmed[ln.order_line_id] = programmed.get(ln.order_line_id, True) and bool(ln.program)
            dates = sorted({s.date for s in db.query(PlanSlot).filter(PlanSlot.task_line_id == ln.id)})
            sheet["dates"].update(dates)
            part = db.get(Part, ln.part_id) if ln.part_id else None
            item = db.get(Item, part.item_id) if part is not None and part.item_id else items.get(ln.order_line_id)
            ol = lines_by_id.get(ln.order_line_id)
            row = {
                "key": "|".join(merged_keys[ln.id]) if ln.id in merged_keys else line_key(ln),
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
                "operation": stage.name if stage is not None else None,
                "invoice_no": ol.invoice_no if ol is not None else None,
            }
            if not ln.part_id and ol is not None:
                # дверь — столбцы как в Excel (13.10)
                row.update(door_cols(row["chars"], ol.source_text, item.name if item else None))
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
        sh = next(x for x in sheets.values() if x["area"] == area)
        film.append({"area": area, "area_name": sh["name"], "label": g["label"], "need_m": round(g["need_m"], 1),
                     "stock_m": stock, "min_width_mm": g["min_width"], "cut_on_site": sh["cut_on_site"]})
        if stock + 0.05 < g["need_m"]:
            warnings.append(f"Не хватает плёнки {g['label']} на {sh['name']}: нужно {g['need_m']:.0f} м, "
                            f"на складе {stock:.0f} м (не уже {g['min_width']:g} мм)")

    # нестандартное изделие с операцией «программа станка» — программу делает
    # конструктор; что типовое — условие у типа изделия
    for lid in sorted(milled_lines):
        item = items.get(lid)
        if item is None or programmed.get(lid) or is_standard(db, item) is not False:
            continue
        warnings.append(f"Нестандартное изделие — программу станка делает конструктор: {item.name}")

    # материалы и комплектующие по составу (без своего маршрута — не задания).
    # 13.10: у каждой — группа (комплектующие п/ф отдельно, материалы — по
    # своей группе: МДФ, пенопласт, клей…) и участок, где расходуется, —
    # блоками на печать и вкладкой на листе участка (детали каркаса — на сборке каркаса)
    from app.models.items import ItemGroup

    totals: dict[tuple[str, str | None], float] = defaultdict(float)
    units: dict[str, str | None] = {}
    groups_of: dict[str, str] = {}
    group_names = {g.id: g.name for g in db.query(ItemGroup)}

    def first_area(item_id: int) -> str | None:
        st = db.query(PartStage).filter(PartStage.item_id == item_id).order_by(PartStage.sequence_order).first()
        return st.area if st is not None else None

    # Материал, нарезаемый кусками (пенопласт, 19.10): у правила состава
    # задан размер куска — показываем куски «200×1900 — N шт», площадь листа —
    # в примечании (потребность и закупка по-прежнему в м²).
    from app.models.items import ItemTypeComponent
    from app.services.expressions import ExpressionError, evaluate_number

    ctx_cache: dict[int, dict | None] = {}
    sheet_area: dict[str, float] = defaultdict(float)
    sheet_of: dict[str, str] = {}

    def piece_size(parent_id: int, rule_id: int | None) -> tuple[float, float] | None:
        rule = db.get(ItemTypeComponent, rule_id) if rule_id else None
        if rule is None or not rule.width_expr or not rule.length_expr or rule.component_type_id:
            return None
        if parent_id not in ctx_cache:
            parent = db.get(Item, parent_id)
            ctx_cache[parent_id] = (
                type_rules.context_from_values(db, parent.type, type_rules.item_values(db, parent)) if parent and parent.type else None
            )
        ctx = ctx_cache[parent_id]
        if ctx is None:
            return None
        try:
            w, ln = evaluate_number(rule.width_expr, ctx), evaluate_number(rule.length_expr, ctx)
        except ExpressionError:
            return None
        return (w, ln) if w > 0 and ln > 0 else None

    def walk(item_id: int, k: float, depth: int = 0) -> None:
        comps = planned_components(db.query(ItemComponent).filter(ItemComponent.parent_item_id == item_id).all())
        names = live_item_names(db, {c.component_item_id for c in comps})
        for c in comps:
            q = float(c.qty_per_unit) * k
            part = db.query(Part).filter(Part.item_id == c.component_item_id).first()
            if part is None or not part.stages:
                nm = names.get(c.component_item_id) or "?"
                it0 = db.get(Item, c.component_item_id)
                size = piece_size(item_id, c.rule_id) if it0 is not None and (it0.unit or (it0.kind.unit if it0.kind else "") or "").startswith("м²") else None
                if size is not None:
                    w, ln = size
                    piece = f"{nm} — {w:g}×{ln:g}"
                    st = db.get(PartStage, c.stage_id) if c.stage_id else None
                    area = st.area if st is not None else first_area(item_id)
                    totals[(piece, area)] += q * 1_000_000 / (w * ln)
                    units[piece] = "шт"
                    groups_of[piece] = (group_names.get(it0.group_id) if it0.group_id else None) or (nm.split()[0] if nm else "Прочее")
                    sheet_area[piece] += q
                    sheet_of[piece] = nm
                    continue
                st = db.get(PartStage, c.stage_id) if c.stage_id else None
                area = st.area if st is not None else first_area(item_id)
                totals[(nm, area)] += q
                it = db.get(Item, c.component_item_id)
                units[nm] = it.unit if it else None
                if it is not None and it.kind is not None and it.kind.code == "pf":
                    groups_of[nm] = "Комплектующие"
                else:
                    groups_of[nm] = (group_names.get(it.group_id) if it and it.group_id else None) or (nm.split()[0] if nm else "Прочее")
            if depth < 4:
                walk(c.component_item_id, q, depth + 1)

    for l in order.lines:
        walk(l.item_id, float(l.quantity))
    by_name: dict[str, dict] = {}
    for (nm, area), q in totals.items():
        m = by_name.setdefault(nm, {"name": nm, "qty": 0.0, "unit": units.get(nm), "group": groups_of.get(nm, "Прочее"), "areas": {}})
        m["qty"] += q
        m["areas"][area] = m["areas"].get(area, 0.0) + q
    materials = [
        {"name": m["name"], "qty": round(m["qty"], 3), "unit": m["unit"], "group": m["group"],
         "comment": (f"из листа «{sheet_of[m['name']]}», " + f"{sheet_area[m['name']]:.2f}".replace(".", ",") + " м²" if m["name"] in sheet_of else None),
         "areas": [{"area": a, "area_name": areas[a].name if a in areas else None, "qty": round(q, 3)} for a, q in m["areas"].items()]}
        for m in sorted(by_name.values(), key=lambda m: (m["group"] != "Комплектующие", m["group"], m["name"]))
    ]
    # на лист участка — что на нём расходуется (вкладка «Комплектующие»)
    from app.services.task_print import _cut_comment

    for m in materials:
        for a in m["areas"]:
            sh = next((x for x in sheets.values() if x["area"] == a["area"]), None)
            if sh is not None:
                sh.setdefault("components", []).append(
                    {"name": m["name"], "qty": a["qty"], "unit": m["unit"], "group": m["group"], "comment": _cut_comment(m["name"]) or m.get("comment")}
                )

    # п/ф заказа: сколько нужно, сколько со склада, сколько в работу и для
    # скольких строк заказа — откуда берутся детали на листах участков
    pf: dict[int, dict] = {}
    for pk in picks:
        part = db.get(Part, pk.part_id)
        g = pf.setdefault(pk.part_id, {"name": part.name if part else f"деталь #{pk.part_id}", "need": 0.0, "from_stock": 0.0,
                                       "launch": 0.0, "lines": set(), "lamination_area": None})
        g["from_stock"] += float(pk.from_stock or 0)
        g["launch"] += float(pk.quantity or 0)
        g["need"] += float(pk.quantity or 0) + float(pk.from_stock or 0)
        g["lines"].add(pk.order_line_id)
        if pk.lamination_area:
            g["lamination_area"] = areas[pk.lamination_area].name if pk.lamination_area in areas else pk.lamination_area
    pf_rows = sorted(
        ({**{k: v for k, v in g.items() if k != "lines"}, "need": round(g["need"], 2), "from_stock": round(g["from_stock"], 2),
          "launch": round(g["launch"], 2), "order_lines": len(g["lines"])} for g in pf.values()),
        key=lambda r: r["name"],
    )

    seq = []
    for s in sheets.values():
        d = sorted(s.pop("dates"))
        s["date_from"] = d[0].isoformat() if d else None
        s["date_to"] = d[-1].isoformat() if d else None
        s["total"] = round(sum(r["qty"] for r in s["rows"] if not r.get("skipped")), 2)
        seq.append(s)
    seq.sort(key=lambda s: (s["date_from"] or "9999", s["name"]))
    return {
        "sheets": seq,
        "film": sorted(film, key=lambda f: (f["area_name"], f["label"])),
        "materials": materials,
        "pf": pf_rows,
        "warnings": warnings,
        "finish": sched.finish.isoformat() if sched.finish else None,
        "late": bool(sched.late),
        "doors": float(sum(float(l.quantity) for l in order.lines)),
    }
