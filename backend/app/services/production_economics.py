"""Экономика производства (02.10): план/факт плёнки против норм и выработка.

План/факт плёнки — по строкам заданий с плёнкой, отчитанным за период:
  норма = годные × длина детали (все проходы, кроме досчётов расхода рулона);
  брак  = брак × длина детали;
  факт  — от рулона, а не от отчётов: рулон, закрытый на участке (вернули
          или списали), израсходовал «выдано − вернули/списано» метров; это
          делится между строками, где рулон указан в отчётах, по штукам ×
          длина. Так два захода окутки, «+ ещё рулон» и досчёты при
          возврате учитываются сами. Рулон ещё на участке — строка «в
          работе», факт по нему — по отчётам (уточнится при возврате);
  перерасход = факт − норма (брак, обрезки, недоучёт).
Рубли — по последней цене м² этой плёнки из заявок поставщику.

Выработка — по отчётам мастеров: кто, когда, на каком участке, сколько
годных и брака (без закрытий «сделано полностью» и пустых отметок рулона)."""

from collections import defaultdict
from datetime import date, datetime, time, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.dictionaries import Color, Material, Thickness
from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport, REPORT_CLOSE, REPORT_RECON, REPORT_REMAINDER
from app.models.production_orders import ProductionOrder, ProductionOrderLine
from app.models.purchasing import PurchaseRequest
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.services.production import report_film_m


def _period(date_from: date, date_to: date):
    start = datetime.combine(date_from, time.min).astimezone(timezone.utc)
    end = datetime.combine(date_to, time.max).astimezone(timezone.utc)
    return start, end


def _last_prices(db: Session, at: date | None = None) -> dict[tuple[int, int, int], float]:
    """Цена м² плёнки в рублях (материал, цвет, толщина): из цен позиций
    (вручную, 1С, УПД — services/prices, по общему курсу; у нескольких
    производителей — самая свежая), иначе — последняя из заявок поставщику."""
    from app.models.dictionaries import MaterialSku
    from app.services.prices import current_price, film_rub_per_m2, rates

    out: dict[tuple[int, int, int], float] = {}
    for r in (
        db.query(PurchaseRequest)
        .filter(PurchaseRequest.price_per_m2.isnot(None))
        .order_by(PurchaseRequest.created_at.asc())
    ):
        out[(r.material_id, r.color_id, r.thickness_id)] = float(r.price_per_m2)
    rate_map = rates(db)
    fresh: dict[tuple[int, int, int], tuple] = {}
    for sku in db.query(MaterialSku).filter(MaterialSku.item_id.isnot(None)):
        p = current_price(db, sku.item_id, at)
        if p is None:
            continue
        rub = film_rub_per_m2(db, sku.item_id, sku.native_width_mm, at, rate_map)
        key = (sku.material_id, sku.color_id, sku.thickness_id)
        if rub is not None and (key not in fresh or (p.valid_from, p.id) > fresh[key][0]):
            fresh[key] = ((p.valid_from, p.id), rub)
    out.update({k: v[1] for k, v in fresh.items()})
    return out


def _is_film_adjustment(r) -> bool:
    return r.kind in (REPORT_RECON, REPORT_REMAINDER)


def film_plan_fact(db: Session, date_from: date, date_to: date, area: str | None = None) -> list[dict]:
    from app.models.events import EventType, MaterialEvent

    start, end = _period(date_from, date_to)
    # Строки с отчётом за период — подзапросом: DISTINCT по самим строкам
    # Postgres не умеет (в строке есть JSON-поле manual_changes).
    reported = (
        db.query(ProductionTaskLineReport.task_line_id)
        .filter(ProductionTaskLineReport.reported_at >= start, ProductionTaskLineReport.reported_at <= end)
        .distinct()
    )
    q = (
        db.query(ProductionTaskLine, ProductionTask)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTaskLine.material_id.isnot(None), ProductionTaskLine.id.in_(reported))
    )
    if area:
        q = q.filter(ProductionTask.area == area)
    lines = {ln.id: (ln, t) for ln, t in q}
    if not lines:
        return []
    reps = db.query(ProductionTaskLineReport).filter(ProductionTaskLineReport.task_line_id.in_(list(lines))).all()
    agg = {lid: {"good": 0.0, "defect": 0.0, "fact": 0.0, "estimated": False, "rolls": set(), "no_roll": 0.0} for lid in lines}
    for r in reps:
        # в норму — все проходы (окутка в 2 захода: первый не засчитан в
        # строку, но плёнку расходует); досчёт при возврате и «остаток указан
        # вручную» — уточнение расхода рулона, а не новые штуки
        if not _is_film_adjustment(r):
            agg[r.task_line_id]["good"] += float(r.good_pieces)
            agg[r.task_line_id]["defect"] += float(r.defect_pieces or 0)
            if not r.material_unit_id and r.kind != REPORT_CLOSE:
                agg[r.task_line_id]["no_roll"] += float(r.good_pieces) + float(r.defect_pieces or 0)
        if r.material_unit_id:
            agg[r.task_line_id]["rolls"].add(r.material_unit_id)
    # рулоны этих строк — со всеми их отчётами (рулон общий на участке)
    unit_ids = {u for a in agg.values() for u in a["rolls"]}
    weight: dict[int, dict[int, float]] = defaultdict(lambda: defaultdict(float))
    line_len: dict[int, float] = {}
    if unit_ids:
        for r, ln in (
            db.query(ProductionTaskLineReport, ProductionTaskLine)
            .join(ProductionTaskLine, ProductionTaskLine.id == ProductionTaskLineReport.task_line_id)
            .filter(ProductionTaskLineReport.material_unit_id.in_(unit_ids))
        ):
            line_len[ln.id] = float(ln.length_m or 0)
            weight[r.material_unit_id][ln.id] += report_film_m(
                float(r.good_pieces), float(r.defect_pieces or 0), float(ln.length_m or 0),
                None if r.film_used_m is None else float(r.film_used_m),
            )
        closed: dict[int, float] = defaultdict(float)
        for ev in db.query(MaterialEvent).filter(
            MaterialEvent.unit_id.in_(unit_ids), MaterialEvent.event_type.in_([EventType.VOZVRAT, EventType.SPISANIE])
        ):
            if ev.event_type == EventType.VOZVRAT or ev.area:
                closed[ev.unit_id] += -float(ev.quantity_delta_m)
        units = {u.id: u for u in db.query(MaterialUnit).filter(MaterialUnit.id.in_(unit_ids))}
        for uid, w in weight.items():
            total_w = sum(w.values())
            u = units.get(uid)
            still = u is not None and u.status == UnitStatus.VYDAN_UCHASTKU
            used = total_w if still or uid not in closed else closed[uid]
            for lid, part in w.items():
                if lid in agg and total_w > 0:
                    agg[lid]["fact"] += used * part / total_w
                    if still:
                        agg[lid]["estimated"] = True
    prices = _last_prices(db, date_to)
    mats = {m.id: m.name for m in db.query(Material)}
    cols = {c.id: c.name for c in db.query(Color)}
    ths = {x.id: float(x.value_mm) for x in db.query(Thickness)}
    areas = {x.code: x.name for x in db.query(Area)}
    out = []
    for lid, (ln, t) in lines.items():
        a = agg[lid]
        length = float(ln.length_m or 0)
        norm = a["good"] * length
        defect_m = a["defect"] * length
        has_rolls = bool(a["rolls"])
        fact = a["fact"] if has_rolls else None
        over = (fact - norm) if fact is not None else None
        order = db.get(ProductionOrder, t.production_order_id) if t.production_order_id else None
        ol = db.get(ProductionOrderLine, ln.order_line_id) if ln.order_line_id else None
        width = float(ln.strip_width_mm or ln.width_mm or 0)
        price = prices.get((ln.material_id, ln.color_id, ln.thickness_id))
        rub_per_m = price * width / 1000 if price and width else None
        out.append({
            "line_id": lid,
            "task_id": t.id,
            "area": t.area,
            "area_name": areas.get(t.area, t.area),
            "order": f"№{order.id} «{order.name}»" if order else None,
            "invoice_no": getattr(ol, "invoice_no", None) if ol else None,
            "part_name": ln.part_name,
            "film": f"{mats.get(ln.material_id, '')} {cols.get(ln.color_id, '')} {ths.get(ln.thickness_id, 0):g}".strip(),
            "width_mm": width,
            "good": round(a["good"], 2),
            "defect": round(a["defect"], 2),
            "rolls": len(a["rolls"]),
            # штуки из отчётов без рулона — их плёнка в факт строки не попала
            "no_roll_pieces": round(a["no_roll"], 2),
            "norm_m": round(norm, 2),
            "defect_m": round(defect_m, 2),
            "fact_m": round(fact, 2) if fact is not None else None,
            "over_m": round(over, 2) if over is not None else None,
            "over_pct": round(over / norm * 100, 1) if over is not None and norm else None,
            "price_m2": price,
            "fact_rub": round(fact * rub_per_m, 2) if rub_per_m and fact is not None else None,
            "over_rub": round(over * rub_per_m, 2) if rub_per_m and over is not None else None,
            "in_work": a["estimated"],
        })
    return sorted(out, key=lambda r: -(r["over_m"] or 0))


def output_report(db: Session, date_from: date, date_to: date, area: str | None = None) -> list[dict]:
    """Выработка: строка — сотрудник × участок × день (по отчётам)."""
    start, end = _period(date_from, date_to)
    q = (
        db.query(ProductionTaskLineReport, ProductionTaskLine, ProductionTask)
        .join(ProductionTaskLine, ProductionTaskLine.id == ProductionTaskLineReport.task_line_id)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTaskLineReport.reported_at >= start, ProductionTaskLineReport.reported_at <= end)
    )
    if area:
        q = q.filter(ProductionTask.area == area)
    users = {u.id: (u.full_name or u.username) for u in db.query(User)}
    areas = {x.code: x for x in db.query(Area)}
    rows: dict[tuple, dict] = {}
    for rep, ln, t in q:
        if float(rep.good_pieces) == 0 and float(rep.defect_pieces or 0) == 0:
            continue  # отметка «рулон использован» без штук
        if rep.kind == REPORT_CLOSE:
            continue  # закрытие строки без отчёта — не выработка
        if not rep.counts_toward_line:
            continue  # досчёт расхода / доп. рулон / первый заход — не новые штуки
        day = rep.reported_at.astimezone().date()
        key = (rep.reported_by, t.area, day)
        r = rows.setdefault(key, {
            "user": users.get(rep.reported_by, "—"), "area": t.area,
            "area_name": areas[t.area].name if t.area in areas else t.area, "date": day.isoformat(),
            "good": 0.0, "defect": 0.0, "reports": 0, "lines": set(),
            "capacity": float(areas[t.area].capacity_per_shift or 0) * int(areas[t.area].shifts_per_day or 1)
            if t.area in areas and areas[t.area].capacity_per_shift else None,
        })
        if rep.counts_toward_line:
            r["good"] += float(rep.good_pieces)
            r["defect"] += float(rep.defect_pieces or 0)
        r["reports"] += 1
        r["lines"].add(ln.id)
    out = []
    for r in rows.values():
        total = r["good"] + r["defect"]
        out.append({
            **{k: v for k, v in r.items() if k != "lines"},
            "good": round(r["good"], 2), "defect": round(r["defect"], 2), "lines": len(r["lines"]),
            "defect_pct": round(r["defect"] / total * 100, 1) if total else 0.0,
        })
    return sorted(out, key=lambda r: (r["date"], r["area_name"], r["user"]), reverse=True)


# Склад плёнки — какие операции журнала считаем выработкой и как называем.
_WAREHOUSE_OPS = [
    ("receipt", "Приёмка", ("PRIHOD",)),
    ("cut", "Резка (продольная и раскрой)", ("PRODOLNAYA_REZKA", "RASKROY")),
    ("issue", "Выдача участку", ("VYDACHA_UCHASTKU",)),
    ("return", "Возврат с участка", ("VOZVRAT",)),
    ("transfer_out", "Перемещение — отправлено", ("PEREMESHCHENIE_NACHATO",)),
    ("transfer_in", "Перемещение — принято", ("PEREMESHCHENIE_PRINYATO",)),
    ("writeoff", "Списание", ("SPISANIE",)),
    ("inventory", "Инвентаризация", (
        "INVENTARIZATSIYA_PODTVERZHDENO", "INVENTARIZATSIYA_PEREMESHCHENO", "INVENTARIZATSIYA_IZLISHEK",
        "INVENTARIZATSIYA_NEDOSTACHA", "INVENTARIZATSIYA_NEDOSTACHA_OSTAVLENO",
    )),
    ("adjust", "Корректировка", ("KORREKTIROVKA",)),
]


def daily_output(db: Session, date_from: date, date_to: date) -> dict:
    """Ежедневная выработка по всем участкам и складу плёнки.

    Производственные участки — по отчётам мастеров (годные, брак).
    Склад плёнки — по журналу движений: операций (единиц) и метров по
    каждому виду работы; у резки — число резок (операций) и полученных
    единиц. В ячейке — итог за день и кто сколько сделал."""
    from app.models.events import EventType, MaterialEvent

    start, end = _period(date_from, date_to)
    users = {u.id: (u.full_name or u.username) for u in db.query(User)}
    areas = {x.code: x for x in db.query(Area)}
    rows: dict[str, dict] = {}

    def cell(row_key: str, day: str) -> dict:
        return rows[row_key]["by_day"].setdefault(day, {"value": 0.0, "extra": 0.0, "users": defaultdict(lambda: [0.0, 0.0])})

    # ── производство
    for rep, ln, t in (
        db.query(ProductionTaskLineReport, ProductionTaskLine, ProductionTask)
        .join(ProductionTaskLine, ProductionTaskLine.id == ProductionTaskLineReport.task_line_id)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTaskLineReport.reported_at >= start, ProductionTaskLineReport.reported_at <= end)
    ):
        g, d = float(rep.good_pieces), float(rep.defect_pieces or 0)
        if (g == 0 and d == 0) or not rep.counts_toward_line or rep.kind == REPORT_CLOSE:
            continue
        key = f"area:{t.area}"
        area = areas.get(t.area)
        rows.setdefault(key, {
            "group": "production", "key": key, "label": area.name if area else t.area,
            "value_label": "годных, шт", "extra_label": "брак, шт", "by_day": {},
            "capacity": float(area.capacity_per_shift) * int(area.shifts_per_day or 1) if area and area.capacity_per_shift else None,
        })
        c = cell(key, rep.reported_at.astimezone().date().isoformat())
        c["value"] += g
        c["extra"] += d
        u = c["users"][users.get(rep.reported_by, "—")]
        u[0] += g
        u[1] += d

    # ── склад плёнки
    op_of = {getattr(EventType, name): (k, label) for k, label, names in _WAREHOUSE_OPS for name in names}
    cut_ops: dict[str, set] = defaultdict(set)
    for ev in db.query(MaterialEvent).filter(
        MaterialEvent.timestamp >= start, MaterialEvent.timestamp <= end, MaterialEvent.event_type.in_(list(op_of))
    ):
        k, label = op_of[ev.event_type]
        key = f"wh:{k}"
        rows.setdefault(key, {
            "group": "warehouse", "key": key, "label": label,
            "value_label": "резок" if k == "cut" else "операций", "extra_label": "единиц" if k == "cut" else "метров",
            "by_day": {}, "capacity": None, "order": [o[0] for o in _WAREHOUSE_OPS].index(k),
        })
        day = ev.timestamp.astimezone().date().isoformat()
        c = cell(key, day)
        who = users.get(ev.user_id, "—")
        if k == "cut":
            # резка: операция одна, единиц из неё несколько
            op_id = ev.cutting_operation_id or f"e{ev.event_id}"
            if op_id not in cut_ops[f"{day}:{who}"]:
                cut_ops[f"{day}:{who}"].add(op_id)
                c["value"] += 1
                c["users"][who][0] += 1
            c["extra"] += 1
            c["users"][who][1] += 1
        else:
            m = abs(float(ev.quantity_delta_m or 0))
            c["value"] += 1
            c["extra"] += m
            c["users"][who][0] += 1
            c["users"][who][1] += m

    days = sorted({d for r in rows.values() for d in r["by_day"]}, reverse=True)
    out = []
    for r in rows.values():
        by_day = {
            d: {
                "value": round(c["value"], 2), "extra": round(c["extra"], 2),
                "users": sorted(({"user": n, "value": round(v[0], 2), "extra": round(v[1], 2)} for n, v in c["users"].items()), key=lambda x: -x["value"]),
            }
            for d, c in r["by_day"].items()
        }
        out.append({
            **{k: v for k, v in r.items() if k not in ("by_day", "order")},
            "by_day": by_day,
            "total": round(sum(c["value"] for c in by_day.values()), 2),
            "total_extra": round(sum(c["extra"] for c in by_day.values()), 2),
            "_sort": (0, r["label"]) if r["group"] == "production" else (1, r.get("order", 99)),
        })
    out.sort(key=lambda r: r.pop("_sort"))
    return {"days": days, "rows": out}


def area_costs(db: Session, date_from: date, date_to: date) -> list[dict]:
    """Себестоимость по участкам за период (05.10): работа, плёнка,
    материалы и на штуку годных.

    Работа: сдельно — годные × расценка операции (у позиции) или участка;
    за смену — дней с выпуском × смен в день × людей в смене × ставка
    смены. Плёнка — факт по рулонам (как в план/факте) × цена м²;
    материалы — расход по отчётам операций × цена позиции на дату. Чего не
    хватает для расчёта — в issues, а не нулём."""
    from app.models.dictionaries import PartStage
    from app.models.items import MOVE_CONSUMPTION, Item, MaterialMove
    from app.services.prices import price_rub, rates

    start, end = _period(date_from, date_to)
    areas = {a.code: a for a in db.query(Area)}
    rows: dict[str, dict] = {}

    def row(code: str) -> dict:
        if code not in rows:
            a = areas.get(code)
            rows[code] = {
                "area": code, "area_name": a.name if a else code, "pay_mode": a.pay_mode if a else None,
                "good": 0.0, "defect": 0.0, "labor_rub": 0.0, "film_rub": 0.0, "materials_rub": 0.0,
                "days": set(), "no_rate": 0.0, "film_no_price": 0, "materials_no_price": set(), "issues": [],
            }
        return rows[code]

    stage_rate = {s.id: float(s.piece_rate) for s in db.query(PartStage).filter(PartStage.piece_rate.isnot(None))}
    reps = (
        db.query(ProductionTaskLineReport, ProductionTaskLine, ProductionTask)
        .join(ProductionTaskLine, ProductionTaskLine.id == ProductionTaskLineReport.task_line_id)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTaskLineReport.reported_at >= start, ProductionTaskLineReport.reported_at <= end,
                ProductionTaskLineReport.kind.is_(None), ProductionTaskLineReport.counts_toward_line.is_(True))
    )
    for rep, ln, t in reps:
        g, d = float(rep.good_pieces), float(rep.defect_pieces or 0)
        if g == 0 and d == 0:
            continue
        r = row(t.area)
        r["good"] += g
        r["defect"] += d
        r["days"].add(rep.reported_at.astimezone().date())
        a = areas.get(t.area)
        if a is not None and a.pay_mode == "piece":
            rate = stage_rate.get(ln.part_stage_id) if ln.part_stage_id else None
            if rate is None and a.piece_rate is not None:
                rate = float(a.piece_rate)
            if rate is None:
                r["no_rate"] += g
            else:
                r["labor_rub"] += g * rate
    for code, r in rows.items():
        a = areas.get(code)
        if a is None or not a.pay_mode:
            r["issues"].append("вид оплаты не задан — работа не считается")
        elif a.pay_mode == "shift":
            if a.shift_rate is None or a.shift_headcount is None:
                r["issues"].append("за смену: не задана ставка или число людей")
            else:
                r["labor_rub"] = len(r["days"]) * (a.shifts_per_day or 1) * float(a.shift_headcount) * float(a.shift_rate)
        if r["no_rate"]:
            r["issues"].append(f"без расценки: {r['no_rate']:g} шт")

    for f in film_plan_fact(db, date_from, date_to):
        r = row(f["area"])
        if f["fact_rub"] is not None:
            r["film_rub"] += f["fact_rub"]
        elif f["fact_m"]:
            r["film_no_price"] += 1

    rate_map = rates(db)
    moves = (
        db.query(MaterialMove, ProductionTask.area)
        .join(ProductionTaskLine, ProductionTaskLine.id == MaterialMove.task_line_id)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(MaterialMove.kind == MOVE_CONSUMPTION, MaterialMove.occurred_at >= start, MaterialMove.occurred_at <= end)
    )
    names = {}
    for mv, code in moves:
        r = row(code)
        pr = price_rub(db, mv.item_id, mv.occurred_at.astimezone().date(), rate_map)
        if pr is None:
            names.setdefault(mv.item_id, db.get(Item, mv.item_id).name)
            r["materials_no_price"].add(names[mv.item_id])
        else:
            r["materials_rub"] += -float(mv.qty) * pr.rub

    out = []
    for r in rows.values():
        if r["film_no_price"]:
            r["issues"].append(f"плёнка без цены: {r['film_no_price']} строк")
        if r["materials_no_price"]:
            r["issues"].append("материалы без цены: " + ", ".join(sorted(r["materials_no_price"])[:5]))
        total = r["labor_rub"] + r["film_rub"] + r["materials_rub"]
        out.append({
            "area": r["area"], "area_name": r["area_name"], "pay_mode": r["pay_mode"],
            "good": round(r["good"], 2), "defect": round(r["defect"], 2), "days": len(r["days"]),
            "labor_rub": round(r["labor_rub"], 2), "film_rub": round(r["film_rub"], 2),
            "materials_rub": round(r["materials_rub"], 2), "total_rub": round(total, 2),
            "per_piece_rub": round(total / r["good"], 2) if r["good"] else None,
            "issues": r["issues"],
        })
    return sorted(out, key=lambda x: -x["total_rub"])
