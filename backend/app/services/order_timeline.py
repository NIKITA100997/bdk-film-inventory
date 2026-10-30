"""Сквозной таймлайн заказа (Order Timeline Hub).
Визуализация стадий:
1. Счёт 1С (Заказ клиента)
2. Сырьё и материалы (Резерв плёнки / наличие)
3. Заготовки ПФ (Стоевые, поперечные, щиты)
4. Пресс / Окутка (Облицовка плёнкой / прессование)
5. Сборка / Упаковка (Финишная сборка)
6. Склад ГП (Приёмка на склад готовой продукции)
7. Отгружен (Передача клиенту)
"""

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models.customer_orders import (
    CO_ACCEPTED,
    CO_CANCELLED,
    CO_DRAFT,
    CO_RETURNED,
    CO_SUBMITTED,
    CustomerOrder,
)
from app.models.finished_goods import FG_RECEIPT, FG_SHIPMENT, FgMove
from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.production_orders import (
    ORDER_CLOSED,
    ORDER_DRAFT,
    ORDER_RELEASED,
    ProductionOrder,
    ProductionOrderLine,
)
from app.services import customer_orders as cos
from app.services.planning import order_plan_status


@dataclass
class TimelineStageItem:
    key: str
    name: str
    status: str  # "completed", "in_progress", "waiting", "warning"
    progress_pct: int
    qty_done: float
    qty_total: float
    description: str
    detail: str | None = None
    date: date | None = None
    is_bottleneck: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "name": self.name,
            "status": self.status,
            "progress_pct": self.progress_pct,
            "qty_done": round(self.qty_done, 2),
            "qty_total": round(self.qty_total, 2),
            "description": self.description,
            "detail": self.detail,
            "date": self.date.isoformat() if self.date else None,
            "is_bottleneck": self.is_bottleneck,
        }


@dataclass
class OrderTimeline:
    order_id: int
    invoice_no: str
    customer: str | None
    qty: float
    received: float
    shipped: float
    promised_ready: date | None
    ship_date: date | None
    plan_finish: date | None
    overall_progress_pct: int
    current_stage_key: str
    current_stage_label: str
    status_summary: str
    delay_days: int
    stages: list[TimelineStageItem] = field(default_factory=list)
    client_message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "order_id": self.order_id,
            "invoice_no": self.invoice_no,
            "customer": self.customer,
            "qty": round(self.qty, 2),
            "received": round(self.received, 2),
            "shipped": round(self.shipped, 2),
            "promised_ready": self.promised_ready.isoformat() if self.promised_ready else None,
            "ship_date": self.ship_date.isoformat() if self.ship_date else None,
            "plan_finish": self.plan_finish.isoformat() if self.plan_finish else None,
            "overall_progress_pct": self.overall_progress_pct,
            "current_stage_key": self.current_stage_key,
            "current_stage_label": self.current_stage_label,
            "status_summary": self.status_summary,
            "delay_days": self.delay_days,
            "stages": [s.to_dict() for s in self.stages],
            "client_message": self.client_message,
        }


def _calc_customer_timeline(db: Session, co: CustomerOrder) -> OrderTimeline:
    prog = cos.progress(db, co)
    total_qty = float(prog.qty) if prog.qty > 0 else 1.0

    # Linked production orders
    pol_ids = []
    po_ids = [p[0] for p in prog.production_orders]
    pos = db.query(ProductionOrder).filter(ProductionOrder.id.in_(po_ids)).all() if po_ids else []

    # Planning status across linked POs
    plan_finishes = []
    plan_lates = []
    plan_overdues = 0.0
    for po in pos:
        st = order_plan_status(db, po)
        if st.finish:
            plan_finishes.append(st.finish)
        if st.late:
            plan_lates.append(True)
        plan_overdues += st.overdue

    best_plan_finish = max(plan_finishes) if plan_finishes else co.promised_ready

    # Operations & tasks progress
    # Let's inspect operations from tasks belonging to these production orders
    tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id.in_(po_ids)).all() if po_ids else []
    
    # Task completion by area category
    lam_done = 0.0
    lam_planned = 0.0
    press_done = 0.0
    press_planned = 0.0
    pf_done = 0.0
    pf_planned = 0.0
    asm_done = 0.0
    asm_planned = 0.0

    for t in tasks:
        area_code = (t.area or "").lower()
        t_done = float(t.done or 0)
        t_plan = float(t.planned or 0)
        if "lam" in area_code or "wrap" in area_code or "окут" in area_code:
            lam_done += t_done
            lam_planned += t_plan
        elif "press" in area_code or "пресс" in area_code:
            press_done += t_done
            press_planned += t_plan
        elif "blank" in area_code or "pf" in area_code or "загот" in area_code:
            pf_done += t_done
            pf_planned += t_plan
        elif "asm" in area_code or "сбор" in area_code or "упак" in area_code:
            asm_done += t_done
            asm_planned += t_plan

    is_cancelled = co.status == CO_CANCELLED
    is_shipped = prog.shipped >= prog.qty - 0.001 and prog.qty > 0
    is_part_shipped = prog.shipped > 0 and not is_shipped
    is_fg_ready = (prog.received >= prog.qty - 0.001 and prog.qty > 0) or bool(co.ready_at)
    is_in_prod = prog.in_work > 0 or prog.launched > 0

    today = date.today()
    target_date = co.promised_ready or co.ship_date
    delay_days = 0
    if best_plan_finish and target_date:
        delta = (best_plan_finish - target_date).days
        delay_days = max(0, delta)
    elif target_date and today > target_date and not is_fg_ready:
        delay_days = (today - target_date).days

    # 1. Invoice Stage
    if co.status in (CO_ACCEPTED, "assembled", "in_production", "ready", "shipped_part", "shipped"):
        st_invoice = TimelineStageItem(
            key="invoice",
            name="Счёт 1С",
            status="completed",
            progress_pct=100,
            qty_done=prog.qty,
            qty_total=prog.qty,
            description="Заказ принят в производство",
            detail=f"Счёт {co.invoice_no} от {co.invoice_date.strftime('%d.%m.%Y') if co.invoice_date else '—'}",
            date=co.invoice_date,
        )
    elif co.status == CO_SUBMITTED:
        st_invoice = TimelineStageItem(
            key="invoice",
            name="Счёт 1С",
            status="in_progress",
            progress_pct=70,
            qty_done=0,
            qty_total=prog.qty,
            description="Заявка отправлена, ожидает согласования дат",
            detail=f"Счёт {co.invoice_no}",
        )
    else:
        st_invoice = TimelineStageItem(
            key="invoice",
            name="Счёт 1С",
            status="in_progress" if not is_cancelled else "warning",
            progress_pct=30,
            qty_done=0,
            qty_total=prog.qty,
            description="Черновик счёта" if not is_cancelled else "Заказ отменён",
            detail=f"Счёт {co.invoice_no}",
        )

    # 2. Raw Materials Stage (Сырьё и материалы)
    if is_fg_ready or is_shipped or is_in_prod:
        st_materials = TimelineStageItem(
            key="materials",
            name="Сырьё",
            status="completed",
            progress_pct=100,
            qty_done=prog.qty,
            qty_total=prog.qty,
            description="Плёнка и комплектующие выданы в работу",
            detail="Материалы списаны / зарезервированы",
        )
    elif co.status == CO_ACCEPTED:
        st_materials = TimelineStageItem(
            key="materials",
            name="Сырьё",
            status="completed",
            progress_pct=100,
            qty_done=prog.qty,
            qty_total=prog.qty,
            description="Резерв сырья подтверждён",
            detail="Ожидает формирования запуска",
        )
    else:
        st_materials = TimelineStageItem(
            key="materials",
            name="Сырьё",
            status="waiting",
            progress_pct=0,
            qty_done=0,
            qty_total=prog.qty,
            description="Ожидание приёма заказа",
        )

    # 3. Parts Stage (Заготовки ПФ)
    if is_fg_ready or is_shipped:
        st_parts = TimelineStageItem(
            key="parts",
            name="Заготовки ПФ",
            status="completed",
            progress_pct=100,
            qty_done=prog.qty,
            qty_total=prog.qty,
            description="Все комплектующие полуфабрикаты готовы",
        )
    elif pf_planned > 0:
        pf_pct = min(100, int((pf_done / pf_planned) * 100))
        st_parts = TimelineStageItem(
            key="parts",
            name="Заготовки ПФ",
            status="completed" if pf_pct >= 100 else "in_progress",
            progress_pct=pf_pct,
            qty_done=pf_done,
            qty_total=pf_planned,
            description=f"Готово {round(pf_done, 1)} из {round(pf_planned, 1)} шт заготовок",
        )
    elif is_in_prod:
        st_parts = TimelineStageItem(
            key="parts",
            name="Заготовки ПФ",
            status="completed",
            progress_pct=100,
            qty_done=prog.qty,
            qty_total=prog.qty,
            description="Заготовки в наличии на складе ПФ",
        )
    else:
        st_parts = TimelineStageItem(
            key="parts",
            name="Заготовки ПФ",
            status="waiting",
            progress_pct=0,
            qty_done=0,
            qty_total=prog.qty,
            description="Ожидание запуска",
        )

    # 4. Machining / Lamination Stage (Пресс / Окутка)
    mach_done = lam_done + press_done
    mach_planned = lam_planned + press_planned
    if is_fg_ready or is_shipped:
        st_processing = TimelineStageItem(
            key="processing",
            name="Пресс / Окутка",
            status="completed",
            progress_pct=100,
            qty_done=prog.qty,
            qty_total=prog.qty,
            description="Облицовка и прессование завершены",
        )
    elif mach_planned > 0:
        m_pct = min(100, int((mach_done / mach_planned) * 100))
        st_processing = TimelineStageItem(
            key="processing",
            name="Пресс / Окутка",
            status="completed" if m_pct >= 100 else "in_progress",
            progress_pct=m_pct,
            qty_done=mach_done,
            qty_total=mach_planned,
            description=f"Выполнено {round(mach_done, 1)} из {round(mach_planned, 1)} шт",
            is_bottleneck=delay_days > 0 and m_pct < 100,
        )
    elif is_in_prod:
        st_processing = TimelineStageItem(
            key="processing",
            name="Пресс / Окутка",
            status="in_progress",
            progress_pct=50,
            qty_done=round(prog.in_work * 0.5, 1),
            qty_total=prog.qty,
            description=f"В работе {round(prog.in_work, 1)} шт",
        )
    else:
        st_processing = TimelineStageItem(
            key="processing",
            name="Пресс / Окутка",
            status="waiting",
            progress_pct=0,
            qty_done=0,
            qty_total=prog.qty,
            description="В очереди на запуск",
        )

    # 5. Assembly / Packaging (Сборка / Упаковка)
    if is_fg_ready or is_shipped:
        st_assembly = TimelineStageItem(
            key="assembly",
            name="Сборка / Упаковка",
            status="completed",
            progress_pct=100,
            qty_done=prog.qty,
            qty_total=prog.qty,
            description="Изделия собраны и упакованы",
        )
    elif asm_planned > 0:
        a_pct = min(100, int((asm_done / asm_planned) * 100))
        st_assembly = TimelineStageItem(
            key="assembly",
            name="Сборка / Упаковка",
            status="completed" if a_pct >= 100 else "in_progress",
            progress_pct=a_pct,
            qty_done=asm_done,
            qty_total=asm_planned,
            description=f"Собрано {round(asm_done, 1)} из {round(asm_planned, 1)} шт",
        )
    elif st_processing.status == "completed" and not is_fg_ready:
        st_assembly = TimelineStageItem(
            key="assembly",
            name="Сборка / Упаковка",
            status="in_progress",
            progress_pct=40,
            qty_done=0,
            qty_total=prog.qty,
            description="Передано на финальную сборку",
        )
    else:
        st_assembly = TimelineStageItem(
            key="assembly",
            name="Сборка / Упаковка",
            status="waiting",
            progress_pct=0,
            qty_done=0,
            qty_total=prog.qty,
            description="Ожидает завершения пресса/окутки",
        )

    # 6. Finished Goods Warehouse (Склад ГП)
    rec_pct = min(100, int((prog.received / total_qty) * 100)) if prog.qty > 0 else 0
    if is_fg_ready:
        st_warehouse = TimelineStageItem(
            key="warehouse",
            name="Склад ГП",
            status="completed",
            progress_pct=100,
            qty_done=prog.received or prog.qty,
            qty_total=prog.qty,
            description=f"Готово {round(prog.received or prog.qty, 1)} из {round(prog.qty, 1)} шт — на складе ГП",
            date=prog.ready_fact,
        )
    elif prog.received > 0:
        st_warehouse = TimelineStageItem(
            key="warehouse",
            name="Склад ГП",
            status="in_progress",
            progress_pct=rec_pct,
            qty_done=prog.received,
            qty_total=prog.qty,
            description=f"Поступило {round(prog.received, 1)} из {round(prog.qty, 1)} шт",
        )
    else:
        st_warehouse = TimelineStageItem(
            key="warehouse",
            name="Склад ГП",
            status="waiting",
            progress_pct=0,
            qty_done=0,
            qty_total=prog.qty,
            description="Ожидает сдачи из цеха",
        )

    # 7. Shipment (Отгружен)
    ship_pct = min(100, int((prog.shipped / total_qty) * 100)) if prog.qty > 0 else 0
    if is_shipped:
        st_shipment = TimelineStageItem(
            key="shipment",
            name="Отгружен",
            status="completed",
            progress_pct=100,
            qty_done=prog.shipped,
            qty_total=prog.qty,
            description=f"Отгружен полностью ({round(prog.shipped, 1)} шт)",
            date=prog.last_shipped_at,
        )
    elif prog.shipped > 0:
        st_shipment = TimelineStageItem(
            key="shipment",
            name="Отгружен",
            status="in_progress",
            progress_pct=ship_pct,
            qty_done=prog.shipped,
            qty_total=prog.qty,
            description=f"Отгружено частично: {round(prog.shipped, 1)} из {round(prog.qty, 1)} шт",
            date=prog.last_shipped_at,
        )
    else:
        st_shipment = TimelineStageItem(
            key="shipment",
            name="Отгружен",
            status="waiting",
            progress_pct=0,
            qty_done=0,
            qty_total=prog.qty,
            description=f"Обещанная отгрузка: {co.ship_date.strftime('%d.%m.%Y') if co.ship_date else 'не назначена'}",
            date=co.ship_date,
        )

    stages = [st_invoice, st_materials, st_parts, st_processing, st_assembly, st_warehouse, st_shipment]

    # Calculate overall progress percentage
    # Weight: invoice 10%, materials 15%, parts 15%, processing 25%, assembly 15%, warehouse 10%, shipment 10%
    weights = [10, 15, 15, 25, 15, 10, 10]
    total_score = sum(st.progress_pct * w for st, w in zip(stages, weights, strict=True))
    overall_progress_pct = min(100, int(total_score / sum(weights)))

    # Determine current stage
    current_stage = st_invoice
    for st in reversed(stages):
        if st.status in ("in_progress", "completed") and st.progress_pct > 0:
            current_stage = st
            break

    # Status summary
    if is_shipped:
        status_summary = "Отгружен полностью"
    elif is_fg_ready:
        status_summary = "Готов на складе ГП"
    elif delay_days > 0:
        status_summary = f"Отставание {delay_days} дн."
    elif is_in_prod:
        status_summary = "В производстве (в графике)"
    elif co.status == CO_ACCEPTED:
        status_summary = "Принят, ожидает запуск"
    elif co.status == CO_SUBMITTED:
        status_summary = "На согласовании сроков"
    else:
        status_summary = "Черновик"

    # Format quick client message for Telegram/WhatsApp
    ready_date_str = (
        co.promised_ready.strftime("%d.%m.%Y")
        if co.promised_ready
        else (best_plan_finish.strftime("%d.%m.%Y") if best_plan_finish else "уточняется")
    )
    ship_date_str = co.ship_date.strftime("%d.%m.%Y") if co.ship_date else "согласовывается"
    cust_str = f" ({co.customer})" if co.customer else ""
    status_icon = "🟢" if is_fg_ready or is_shipped else ("⚠️" if delay_days > 0 else "⚡")

    client_msg = (
        f"📦 Заказ: счёт {co.invoice_no}{cust_str}\n"
        f"📊 Общая готовность: {overall_progress_pct}% (на складе {round(prog.received, 1)} из {round(prog.qty, 1)} шт)\n"
        f"⚙️ Текущий этап: {current_stage.name} ({current_stage.description})\n"
        f"📅 Готовность: {ready_date_str}\n"
        f"🚚 Отгрузка: {ship_date_str}\n"
        f"{status_icon} Статус: {status_summary}"
    )

    return OrderTimeline(
        order_id=co.id,
        invoice_no=co.invoice_no,
        customer=co.customer,
        qty=prog.qty,
        received=prog.received,
        shipped=prog.shipped,
        promised_ready=co.promised_ready,
        ship_date=co.ship_date,
        plan_finish=best_plan_finish,
        overall_progress_pct=overall_progress_pct,
        current_stage_key=current_stage.key,
        current_stage_label=current_stage.name,
        status_summary=status_summary,
        delay_days=delay_days,
        stages=stages,
        client_message=client_msg,
    )


def get_customer_order_timeline(db: Session, order_id: int) -> OrderTimeline:
    co = db.get(CustomerOrder, order_id)
    if co is None:
        raise ValueError(f"CustomerOrder #{order_id} not found")
    return _calc_customer_timeline(db, co)


def get_production_order_timeline(db: Session, production_order_id: int) -> OrderTimeline:
    po = db.get(ProductionOrder, production_order_id)
    if po is None:
        raise ValueError(f"ProductionOrder #{production_order_id} not found")

    # If linked to a customer order, return customer order timeline
    first_col_id = next((ln.customer_order_line_id for ln in po.lines if ln.customer_order_line_id), None)
    if first_col_id:
        from app.models.customer_orders import CustomerOrderLine

        col = db.get(CustomerOrderLine, first_col_id)
        if col:
            return get_customer_order_timeline(db, col.order_id)

    # Standalone production order (e.g. stock replenishment)
    total_qty = sum(float(ln.quantity) for ln in po.lines) or 1.0
    total_done = sum(float(ln.done) for ln in po.lines)
    rec_qty = float(po.received_qty or 0.0)
    ship_qty = float(po.shipped_qty or 0.0)
    st = order_plan_status(db, po)

    today = date.today()
    target_date = po.promised_ready or po.ship_date
    delay_days = 0
    if st.finish and target_date:
        delay_days = max(0, (st.finish - target_date).days)
    elif target_date and today > target_date and rec_qty < total_qty:
        delay_days = (today - target_date).days

    stages = [
        TimelineStageItem("order", "Заказ на производство", "completed", 100, total_qty, total_qty, f"Заказ №{po.id} «{po.name}»"),
        TimelineStageItem("materials", "Сырьё", "completed" if po.status in (ORDER_RELEASED, ORDER_CLOSED) else "waiting", 100 if po.status in (ORDER_RELEASED, ORDER_CLOSED) else 0, total_qty, total_qty, "Материалы"),
        TimelineStageItem("machining", "Обработка", "completed" if total_done >= total_qty else ("in_progress" if total_done > 0 else "waiting"), min(100, int((total_done / total_qty) * 100)), total_done, total_qty, f"Сделано {total_done} из {total_qty} шт"),
        TimelineStageItem("warehouse", "Склад ГП", "completed" if rec_qty >= total_qty else ("in_progress" if rec_qty > 0 else "waiting"), min(100, int((rec_qty / total_qty) * 100)), rec_qty, total_qty, f"Поступило {rec_qty} из {total_qty} шт"),
        TimelineStageItem("shipment", "Отгрузка", "completed" if ship_qty >= total_qty else ("in_progress" if ship_qty > 0 else "waiting"), min(100, int((ship_qty / total_qty) * 100)), ship_qty, total_qty, f"Отгружено {ship_qty} из {total_qty} шт"),
    ]

    overall_pct = min(100, int((rec_qty / total_qty) * 100)) if total_qty > 0 else 0
    client_msg = (
        f"📦 Заказ: №{po.id} «{po.name}»\n"
        f"📊 Готовность: {overall_pct}% ({rec_qty} из {total_qty} шт)\n"
        f"📅 Срок: {target_date.strftime('%d.%m.%Y') if target_date else '—'}"
    )

    return OrderTimeline(
        order_id=po.id,
        invoice_no=po.name,
        customer=po.customer,
        qty=total_qty,
        received=rec_qty,
        shipped=ship_qty,
        promised_ready=po.promised_ready,
        ship_date=po.ship_date,
        plan_finish=st.finish,
        overall_progress_pct=overall_pct,
        current_stage_key="warehouse" if rec_qty >= total_qty else "machining",
        current_stage_label="Склад ГП" if rec_qty >= total_qty else "Обработка",
        status_summary="Готов" if rec_qty >= total_qty else ("Отставание" if delay_days > 0 else "В работе"),
        delay_days=delay_days,
        stages=stages,
        client_message=client_msg,
    )

