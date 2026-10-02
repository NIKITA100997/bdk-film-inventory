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
from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.production_orders import ProductionOrder, ProductionOrderLine
from app.models.purchasing import PurchaseRequest
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User


def _period(date_from: date, date_to: date):
    start = datetime.combine(date_from, time.min).astimezone(timezone.utc)
    end = datetime.combine(date_to, time.max).astimezone(timezone.utc)
    return start, end


def _last_prices(db: Session) -> dict[tuple[int, int, int], float]:
    """Последняя известная цена м² по плёнке (материал, цвет, толщина)."""
    out: dict[tuple[int, int, int], float] = {}
    for r in (
        db.query(PurchaseRequest)
        .filter(PurchaseRequest.price_per_m2.isnot(None))
        .order_by(PurchaseRequest.created_at.asc())
    ):
        out[(r.material_id, r.color_id, r.thickness_id)] = float(r.price_per_m2)
    return out


def _is_film_adjustment(r) -> bool:
    note = r.note or ""
    return not r.counts_toward_line and (note.startswith("Расход досчитан при возврате") or note.startswith("Остаток указан вручную"))


def film_plan_fact(db: Session, date_from: date, date_to: date, area: str | None = None) -> list[dict]:
    from app.models.events import EventType, MaterialEvent

    start, end = _period(date_from, date_to)
    q = (
        db.query(ProductionTaskLine, ProductionTask)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .join(ProductionTaskLineReport, ProductionTaskLineReport.task_line_id == ProductionTaskLine.id)
        .filter(
            ProductionTaskLine.material_id.isnot(None),
            ProductionTaskLineReport.reported_at >= start,
            ProductionTaskLineReport.reported_at <= end,
        )
        .distinct()
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
            if not r.material_unit_id and not (r.note or "").startswith("Закрыто: сделано полностью"):
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
            weight[r.material_unit_id][ln.id] += (float(r.good_pieces) + float(r.defect_pieces or 0)) * float(ln.length_m or 0)
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
    prices = _last_prices(db)
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
        if (rep.note or "").startswith("Закрыто: сделано полностью"):
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
