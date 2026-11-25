"""Предиктивный «Пульс» — прогноз потенциальных срывов на 2–3 дня вперёд:
1. Заказы с датой отгрузки в ближайшие 3 дня, которые не успевают по остаткам/мощностям.
2. Дефицит плёнки на складе под задания ближайших 3 дней.
3. Дефицит заготовок (П/Ф) под задания ближайших 3 дней.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.customer_orders import CO_ACCEPTED, CO_SUBMITTED, CustomerOrder
from app.models.dictionaries import Color, Material, MaterialSku, Part, Thickness
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.production import PlanSlot, ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.units import MaterialUnit, UnitStatus
from app.services.order_timeline import get_customer_order_timeline


def compute_predictive_risks(db: Session, *, target_date: date | None = None, horizon_days: int = 3) -> list[dict]:
    today = target_date or date.today()
    horizon_end = today + timedelta(days=horizon_days)
    risks: list[dict] = []

    # 1. Прогноз срыва отгрузки в ближайшие 2–3 дня
    upcoming_orders = (
        db.query(CustomerOrder)
        .filter(
            CustomerOrder.status.in_([CO_SUBMITTED, CO_ACCEPTED]),
            CustomerOrder.ship_date.isnot(None),
            CustomerOrder.ship_date >= today,
            CustomerOrder.ship_date <= horizon_end,
            CustomerOrder.ready_at.is_(None),
        )
        .order_by(CustomerOrder.ship_date.asc())
        .limit(20)
        .all()
    )
    at_risk_orders: list[tuple[CustomerOrder, int]] = []
    for co in upcoming_orders:
        tl = get_customer_order_timeline(db, co.id)
        if not tl:
            continue
        incomplete = sum(1 for st in tl.get("stages", []) if st.get("status") != "done")
        if incomplete > 0:
            at_risk_orders.append((co, incomplete))

    if at_risk_orders:
        sample = ", ".join(f"№{co.invoice_no or co.id} ({co.ship_date.strftime('%d.%m')})" for co, _ in at_risk_orders[:3])
        more = f" и ещё {len(at_risk_orders) - 3}" if len(at_risk_orders) > 3 else ""
        risks.append({
            "level": "danger",
            "title": f"Риск срыва отгрузки в ближайшие {horizon_days} дн.: {len(at_risk_orders)} заказ(ов)",
            "text": f"Не завершены производственные этапы у заказов с близкой отгрузкой: {sample}{more}.",
            "action_label": "Открыть заказы",
            "action_link": "/customer-orders?filter=accepted",
        })

    # 2. Собираем активные строки заданий, запланированные на ближайшие 3 дня
    slot_line_ids = {
        row[0]
        for row in db.query(PlanSlot.task_line_id)
        .filter(PlanSlot.date >= today, PlanSlot.date <= horizon_end)
        .distinct()
        .all()
    }
    active_lines_q = (
        db.query(ProductionTaskLine, ProductionTask)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(
            ProductionTask.is_active.is_(True),
            ProductionTaskLine.is_closed.is_(False),
            ProductionTaskLine.production_closed.is_(False),
        )
    )
    all_open_lines = active_lines_q.all()
    horizon_lines = [
        (ln, t)
        for ln, t in all_open_lines
        if ln.id in slot_line_ids
    ]
    if not horizon_lines:
        horizon_lines = all_open_lines[:80]

    line_ids = [ln.id for ln, _ in horizon_lines]
    reported_good: dict[int, float] = {}
    if line_ids:
        for lid, good in (
            db.query(
                ProductionTaskLineReport.task_line_id,
                func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
            )
            .filter(
                ProductionTaskLineReport.task_line_id.in_(line_ids),
                ProductionTaskLineReport.counts_toward_line.is_(True),
            )
            .group_by(ProductionTaskLineReport.task_line_id)
            .all()
        ):
            reported_good[lid] = float(good)

    # Потребность в плёнке по (material_id, color_id, thickness_id)
    film_need: dict[tuple[int, int | None, int | None], float] = defaultdict(float)
    pf_need: dict[int, float] = defaultdict(float)

    for ln, _ in horizon_lines:
        rem = max(0.0, float(ln.quantity_pieces) - reported_good.get(ln.id, 0.0))
        if rem <= 0:
            continue
        if ln.material_id is not None and float(ln.length_m) > 0:
            film_need[(ln.material_id, ln.color_id, ln.thickness_id)] += rem * float(ln.length_m)
        if ln.part_id is not None:
            pf_need[ln.part_id] += rem

    # 3. Проверка дефицита плёнки
    if film_need:
        mat_ids = {k[0] for k in film_need}
        stock_by_key: dict[tuple[int, int | None, int | None], float] = defaultdict(float)
        for mat_id, col_id, th_id, total_len in (
            db.query(
                MaterialSku.material_id,
                MaterialSku.color_id,
                MaterialSku.thickness_id,
                func.coalesce(func.sum(MaterialUnit.length_m), 0),
            )
            .join(MaterialUnit, MaterialUnit.material_sku_id == MaterialSku.id)
            .filter(
                MaterialUnit.status == UnitStatus.NA_KHRANENII,
                MaterialSku.material_id.in_(mat_ids),
            )
            .group_by(MaterialSku.material_id, MaterialSku.color_id, MaterialSku.thickness_id)
            .all()
        ):
            stock_by_key[(mat_id, col_id, th_id)] += float(total_len)

        deficits = []
        for key, need_m in film_need.items():
            have_m = stock_by_key.get(key, 0.0)
            if have_m + 1.0 < need_m:
                deficits.append((key, round(need_m - have_m, 1)))
        if deficits:
            deficits.sort(key=lambda x: -x[1])
            top_key, top_gap = deficits[0]
            mat = db.get(Material, top_key[0])
            col = db.get(Color, top_key[1]) if top_key[1] else None
            th = db.get(Thickness, top_key[2]) if top_key[2] else None
            label = " ".join(x for x in [mat.name if mat else None, col.name if col else None, f"{th.value_mm:g}" if th else None] if x)
            risks.append({
                "level": "warning",
                "title": f"Прогноз дефицита плёнки на {horizon_days} дн.: {len(deficits)} поз.",
                "text": f"Наибольшая нехватка по «{label}» — не хватает ~{top_gap} м на складе под ближайшие задания.",
                "action_label": "К закупкам и дефициту",
                "action_link": "/demand",
            })

    # 4. Проверка дефицита П/Ф (заготовок)
    if pf_need:
        part_ids = set(pf_need.keys())
        pf_stock: dict[int, float] = defaultdict(float)
        for pid, qty in (
            db.query(PartUnit.part_id, func.coalesce(func.sum(PartUnit.quantity_pieces), 0))
            .filter(PartUnit.status == PartUnitStatus.NA_KHRANENII, PartUnit.part_id.in_(part_ids))
            .group_by(PartUnit.part_id)
            .all()
        ):
            pf_stock[pid] += float(qty)

        pf_deficits = []
        for pid, need_q in pf_need.items():
            have_q = pf_stock.get(pid, 0.0)
            if have_q + 0.5 < need_q:
                pf_deficits.append((pid, round(need_q - have_q, 1)))
        if pf_deficits:
            pf_deficits.sort(key=lambda x: -x[1])
            top_pid, top_gap = pf_deficits[0]
            part = db.get(Part, top_pid)
            risks.append({
                "level": "warning",
                "title": f"Прогноз нехватки П/Ф на {horizon_days} дн.: {len(pf_deficits)} дет.",
                "text": f"Дефицит заготовок по «{part.name if part else f'#{top_pid}'}» — не хватает {int(top_gap)} шт под ближайшие задания.",
                "action_label": "Потребность П/Ф",
                "action_link": "/demand?tab=pf",
            })

    if not risks:
        risks.append({
            "level": "success",
            "title": f"Прогноз на {horizon_days} дн.: критических рисков нет",
            "text": "Сырья, заготовок и запаса по срокам отгрузки достаточно на ближайшие смены.",
        })
    return risks
