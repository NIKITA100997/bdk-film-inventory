"""Сквозной поиск по номеру (строка поиска в шапке): число — это может быть
рулон/штрипс плёнки, партия п/ф, задание цеха или заказ на производство.
Отдаём все совпадения — одно открывается сразу, несколько — на выбор.
Видно только то, на что у пользователя есть права (как на самих экранах)."""

import re

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.api.items import list_items
from app.core.security import get_current_user, get_permission_codes
from app.db.session import get_db
from app.models.areas import Area
from app.models.items import sku_item_name
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.production import ProductionTask, ProductionTaskLine
from app.models.production_orders import ProductionOrder, ProductionOrderLine
from app.models.units import MaterialUnit
from app.models.users import User

router = APIRouter(tags=["search"])


class IdHit(BaseModel):
    kind: str  # film_unit / part_unit / task / order
    id: int
    title: str
    subtitle: str | None = None


@router.get("/search/by-id/{number}", response_model=list[IdHit])
def search_by_id(number: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[IdHit]:
    perms = get_permission_codes(user)
    can = lambda *codes: user.is_superuser or bool(perms & set(codes))  # noqa: E731
    hits: list[IdHit] = []
    unit = db.get(MaterialUnit, number)
    if unit is not None:
        sku = unit.material_sku
        hits.append(
            IdHit(
                kind="film_unit", id=unit.id,
                title=f"{'Штрипс' if unit.is_strip else 'Рулон'} ПЛ-{unit.id}: "
                + sku_item_name(sku.material.name, sku.color.name, sku.thickness.value_mm, sku.manufacturer.name),
                subtitle=f"{float(unit.width_mm):g} мм × {float(unit.length_m):g} м · {unit.status.value.replace('_', ' ')}"
                + (f" · {unit.location_code}" if unit.location_code else ""),
            )
        )
    if can("part_units.view", "part_units.manage"):
        lot = db.get(PartUnit, number)
        if lot is not None:
            hits.append(
                IdHit(
                    kind="part_unit", id=lot.id, title=f"Партия ПФ-{lot.id}: {lot.part.name}",
                    subtitle=f"{float(lot.quantity_pieces):g} шт · {lot.stage.name if lot.stage else ''} · "
                    f"{lot.status.value.replace('_', ' ')}" + (f" · {lot.location_code}" if lot.location_code else ""),
                )
            )
    if can("production_tasks.manage", "production_tasks.view", "production_tasks.report"):
        task = db.get(ProductionTask, number)
        if task is not None:
            name = task.name or (task.product_model.name if task.product_model else None) or "без названия"
            hits.append(
                IdHit(
                    kind="task", id=task.id, title=f"Задание цеха №{task.id}: {name}",
                    subtitle=("активно" if task.is_active else "в архиве") + f" · строк: {len(task.lines)}",
                )
            )
        order = db.get(ProductionOrder, number)
        if order is not None:
            status = {"draft": "черновик", "released": "запущен", "closed": "закрыт"}.get(order.status, order.status)
            hits.append(
                IdHit(kind="order", id=order.id, title=f"Заказ на производство №{order.id}: {order.name}", subtitle=status)
            )
    return hits


# --- Общий поиск по названию (09.10) ------------------------------------
# Строка в шапке: «стоевая 1976», «810х2010», номер счёта. Находит
# позиции номенклатуры (детали, плёнку, изделия), задания цеха — по
# названию и строкам, заказы на производство — по названию, позициям и
# номеру счёта. Слова ищутся все, в любом порядке; «x», «×», «*» — как «х».

_X = re.compile(r"\s*[xX×*хХ]\s*(?=\d)")


def search_norm(s: str | None) -> str:
    s = (s or "").lower().replace("ё", "е")
    return _X.sub("х", s)


def _matches(tokens: list[str], *texts: str | None) -> bool:
    hay = " ".join(search_norm(t) for t in texts if t)
    return all(t in hay for t in tokens)


class TextHit(BaseModel):
    kind: str  # item / task / order
    id: int
    title: str
    subtitle: str | None = None
    active: bool = True


class TextSearchOut(BaseModel):
    query: str
    items: list[TextHit]
    tasks: list[TextHit]
    orders: list[TextHit]
    truncated: bool = False


LIMIT = 50
ITEM_VIEW = (
    "materials.manage", "production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view",
    "units.receive", "units.issue", "units.return",
)


@router.get("/search", response_model=TextSearchOut)
def search_text(
    q: str = Query(min_length=2), db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> TextSearchOut:
    perms = get_permission_codes(user)
    can = lambda *codes: user.is_superuser or bool(perms & set(codes))  # noqa: E731
    tokens = search_norm(q).split()
    items: list[TextHit] = []
    tasks: list[TextHit] = []
    orders: list[TextHit] = []
    truncated = False

    matched_items: dict[int, str] = {}
    part_ids: set[int] = set()
    part_names: dict[int, str] = {}
    if can(*ITEM_VIEW):
        all_items = list_items(kind=None, q=None, include_inactive=True, db=db, user=user)
        found = [i for i in all_items if _matches(tokens, i.name, i.code_1c)]
        matched_items = {i.id: i.name for i in found}
        part_names = {i.source_id: i.name for i in found if i.source_type == "part" and i.source_id}
        part_ids = set(part_names)
        lots: dict[int, tuple[int, float]] = {}
        if part_ids:
            for pid, n, pcs in (
                db.query(PartUnit.part_id, func.count(PartUnit.id), func.coalesce(func.sum(PartUnit.quantity_pieces), 0))
                .filter(
                    PartUnit.part_id.in_(part_ids),
                    PartUnit.status.in_([PartUnitStatus.NA_KHRANENII, PartUnitStatus.VYDAN_UCHASTKU]),
                )
                .group_by(PartUnit.part_id)
            ):
                lots[pid] = (n, float(pcs))
        found.sort(key=lambda i: (not i.is_active, i.is_model, len(i.name), i.name.lower()))
        truncated |= len(found) > LIMIT
        for i in found[:LIMIT]:
            sub = [i.kind_name + (" · модель" if i.is_model else "")]
            if i.source_type == "part" and i.source_id in lots:
                n, pcs = lots[i.source_id]
                sub.append(f"в остатке {pcs:g} шт, партий {n}")
            if not i.is_active:
                sub.append("не используется")
            items.append(TextHit(kind="item", id=i.id, title=i.name, subtitle=" · ".join(sub), active=i.is_active))

    if can("production_tasks.manage", "production_tasks.view", "production_tasks.report"):
        areas = {a.code: a.name for a in db.query(Area)}
        # строки заданий: сначала уникальные названия, потом сами строки
        names = [n for (n,) in db.query(ProductionTaskLine.part_name).distinct() if n and _matches(tokens, n)]
        by_task: dict[int, list[ProductionTaskLine]] = {}
        if names or part_ids:
            cond = or_(ProductionTaskLine.part_name.in_(names), ProductionTaskLine.part_id.in_(part_ids))
            for ln in db.query(ProductionTaskLine).filter(cond).order_by(ProductionTaskLine.id):
                by_task.setdefault(ln.task_id, []).append(ln)
        task_ids = set(by_task)
        for (tid, name) in db.query(ProductionTask.id, ProductionTask.name).filter(ProductionTask.name.isnot(None)):
            if _matches(tokens, name):
                task_ids.add(tid)
        found_tasks = db.query(ProductionTask).filter(ProductionTask.id.in_(task_ids)).all() if task_ids else []
        found_tasks.sort(key=lambda t: (not t.is_active, -t.id))
        truncated |= len(found_tasks) > LIMIT
        for t in found_tasks[:LIMIT]:
            name = t.name or (t.product_model.name if t.product_model else None) or "без названия"
            lines = by_task.get(t.id, [])
            sub = [areas.get(t.area, t.area), "активно" if t.is_active else "в архиве"]
            if lines:
                # одинаковые детали (строки разных позиций заказа) — одной суммой
                qty: dict[str, float] = {}
                for ln in lines:
                    key = ln.part_name or part_names.get(ln.part_id, "")
                    qty[key] = qty.get(key, 0) + float(ln.quantity_pieces)
                shown = "; ".join(f"{n} — {v:g} шт" for n, v in list(qty.items())[:3])
                sub.append(shown + (f" и ещё {len(qty) - 3}" if len(qty) > 3 else ""))
            tasks.append(TextHit(kind="task", id=t.id, title=f"Задание №{t.id}: {name}", subtitle=" · ".join(sub), active=t.is_active))

    if can("production_tasks.manage", "production_tasks.view", "production_tasks.report", "sales_calculator.view"):
        hit_lines: dict[int, list[str]] = {}
        for ol in db.query(ProductionOrderLine):
            item_name = matched_items.get(ol.item_id)
            if item_name or _matches(tokens, ol.invoice_no, ol.source_text, ol.note):
                label = item_name or ol.source_text or ""
                hit_lines.setdefault(ol.order_id, []).append(
                    (f"счёт {ol.invoice_no}: " if ol.invoice_no else "") + f"{label} — {float(ol.quantity):g}"
                )
        order_ids = set(hit_lines)
        for (oid, name) in db.query(ProductionOrder.id, ProductionOrder.name):
            if _matches(tokens, name):
                order_ids.add(oid)
        found_orders = db.query(ProductionOrder).filter(ProductionOrder.id.in_(order_ids)).all() if order_ids else []
        status_name = {"draft": "черновик", "released": "запущен", "closed": "закрыт"}
        found_orders.sort(key=lambda o: (o.status == "closed", -o.id))
        truncated |= len(found_orders) > LIMIT
        for o in found_orders[:LIMIT]:
            sub = [status_name.get(o.status, o.status)]
            ls = hit_lines.get(o.id, [])
            if ls:
                sub.append("; ".join(ls[:3]) + (f" и ещё {len(ls) - 3}" if len(ls) > 3 else ""))
            orders.append(
                TextHit(kind="order", id=o.id, title=f"Заказ №{o.id}: {o.name}", subtitle=" · ".join(sub), active=o.status != "closed")
            )

    return TextSearchOut(query=q, items=items, tasks=tasks, orders=orders, truncated=truncated)
