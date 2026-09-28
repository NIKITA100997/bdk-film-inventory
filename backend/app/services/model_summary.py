"""Общая история модели («Щитовая дверь В-10»): все её варианты (размеры,
цвета, кромка) вместе — сколько заказано, сделано, в браке, в работе; какие
цвета и размеры заказывают чаще. Варианты при этом остаются отдельными
позициями (у каждого цвета свои панели и кромка на складе) — сводка
собирает их историю в одно место."""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.dictionaries import PartStage
from app.models.items import Item, ItemPropertyOption, ItemPropertyValue
from app.models.production import ProductionTaskLine, ProductionTaskLineReport
from app.models.production_orders import ORDER_CLOSED, ORDER_DRAFT, ProductionOrder, ProductionOrderLine


@dataclass
class VariantStat:
    item_id: int
    name: str
    is_active: bool
    values: dict[str, str] = field(default_factory=dict)  # свойство → значение (подписью)
    ordered: float = 0.0  # по запущенным и закрытым заказам
    done: float = 0.0  # готово по последней операции маршрута
    defect: float = 0.0
    in_work: float = 0.0  # заказано в незакрытых запущенных минус готово
    draft: float = 0.0  # в черновиках заказов
    orders: int = 0
    last_order_at: datetime | None = None


@dataclass
class ValueStat:
    value: str
    variants: int = 0
    ordered: float = 0.0


@dataclass
class ModelSummary:
    model_id: int
    variants: list[VariantStat]
    totals: dict[str, float]
    by_property: dict[str, list[ValueStat]]
    order_ids: list[int]


def _labels(db: Session, item: Item) -> dict[str, str]:
    props = {p.id: p for p in (item.type.properties if item.type else [])}
    out: dict[str, str] = {}
    for v in db.query(ItemPropertyValue).filter(ItemPropertyValue.item_id == item.id):
        p = props.get(v.property_id)
        if p is None:
            continue
        if p.value_type == "list":
            opt = db.get(ItemPropertyOption, v.option_id) if v.option_id else None
            text = opt.value if opt else ""
        elif p.value_type == "number":
            text = f"{float(v.value_number):g}" if v.value_number is not None else ""
        elif p.value_type == "bool":
            text = "да" if v.value_bool else ""
        else:
            text = v.value_text or ""
        if text:
            out[p.name] = text
    return out


def model_summary(db: Session, model: Item) -> ModelSummary:
    variants = db.query(Item).filter(Item.model_id == model.id).order_by(Item.name).all()
    stats = {v.id: VariantStat(item_id=v.id, name=v.name, is_active=v.is_active, values=_labels(db, v)) for v in variants}
    model_prop = next((p for p in model.type.properties if p.id == model.type.model_property_id), None) if model.type else None

    order_lines = (
        db.query(ProductionOrderLine, ProductionOrder)
        .join(ProductionOrder, ProductionOrder.id == ProductionOrderLine.order_id)
        .filter(ProductionOrderLine.item_id.in_(list(stats)))
        .all()
        if stats
        else []
    )
    # Готово — по последней операции маршрута строки заказа; брак — по всем.
    tls = (
        db.query(ProductionTaskLine)
        .filter(ProductionTaskLine.order_line_id.in_([ol.id for ol, _ in order_lines]))
        .all()
        if order_lines
        else []
    )
    agg = (
        {
            lid: (float(g), float(d))
            for lid, g, d in db.query(
                ProductionTaskLineReport.task_line_id,
                func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0),
                func.coalesce(func.sum(ProductionTaskLineReport.defect_pieces), 0),
            )
            .filter(
                ProductionTaskLineReport.task_line_id.in_([t.id for t in tls]),
                ProductionTaskLineReport.counts_toward_line.is_(True),
            )
            .group_by(ProductionTaskLineReport.task_line_id)
        }
        if tls
        else {}
    )
    seq = {s.id: s.sequence_order for s in db.query(PartStage).filter(PartStage.id.in_({t.part_stage_id for t in tls if t.part_stage_id}))} if tls else {}
    by_order_line: dict[int, list[ProductionTaskLine]] = defaultdict(list)
    for t in tls:
        by_order_line[t.order_line_id].append(t)

    order_ids: set[int] = set()
    orders_per_variant: dict[int, set[int]] = defaultdict(set)
    for ol, order in order_lines:
        s = stats[ol.item_id]
        qty = float(ol.quantity)
        if order.status == ORDER_DRAFT:
            s.draft += qty
            continue
        order_ids.add(order.id)
        orders_per_variant[ol.item_id].add(order.id)
        s.ordered += qty
        lines = by_order_line.get(ol.id, [])
        last = max(lines, key=lambda t: seq.get(t.part_stage_id, 0), default=None)
        done = min(qty, agg.get(last.id, (0.0, 0.0))[0]) if last else 0.0
        s.done += done
        s.defect += sum(agg.get(t.id, (0.0, 0.0))[1] for t in lines)
        if order.status != ORDER_CLOSED:
            s.in_work += max(0.0, qty - done)
        when = order.released_at or order.created_at
        if s.last_order_at is None or (when and when > s.last_order_at):
            s.last_order_at = when
    for vid, ids in orders_per_variant.items():
        stats[vid].orders = len(ids)

    by_property: dict[str, dict[str, ValueStat]] = defaultdict(dict)
    for s in stats.values():
        for prop, value in s.values.items():
            if model_prop is not None and prop == model_prop.name:
                continue
            vs = by_property[prop].setdefault(value, ValueStat(value=value))
            vs.variants += 1
            vs.ordered += s.ordered
    totals = {
        "variants": float(len(stats)),
        "ordered": sum(s.ordered for s in stats.values()),
        "done": sum(s.done for s in stats.values()),
        "defect": sum(s.defect for s in stats.values()),
        "in_work": sum(s.in_work for s in stats.values()),
        "draft": sum(s.draft for s in stats.values()),
        "orders": float(len(order_ids)),
    }
    return ModelSummary(
        model_id=model.id,
        variants=sorted(stats.values(), key=lambda s: (-s.ordered, s.name)),
        totals={k: round(v, 2) for k, v in totals.items()},
        by_property={k: sorted(v.values(), key=lambda x: (-x.ordered, -x.variants, x.value)) for k, v in by_property.items()},
        order_ids=sorted(order_ids, reverse=True),
    )
