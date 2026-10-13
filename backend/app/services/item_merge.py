"""Слияние дублей любой позиции (14.10) — как «объединить» у плёнки, но
для детали п/ф, материала, изделия.

Всё, что ссылается на дубль, переводится на основную позицию: партии и их
журнал, строки заданий и заказов, резервы, пересчёты, движения материала и
склада ГП, цены, состав (где дубль — комплектующее), синонимы. Этапы
(маршрут) — у основной позиции свои: ссылки на этапы дубля сопоставляются по
порядку, иначе по названию; не сопоставилось то, на что есть ссылки, —
слияние не делается. Дубль уходит в архив с пометкой в названии (история не
теряется, как у плёнки), его прежнее название становится синонимом основной.

Плёнка сливается своим «Объединить» (позиции плёнки — материал+цвет+толщина+
производитель), модели царговых (BOM) — не сливаются."""

from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.models.customer_orders import CustomerOrderLine
from app.models.dictionaries import MaterialSku, Part, PartStage
from app.models.finished_goods import FgMove
from app.models.items import Item, ItemAlias, ItemComponent, ItemTypeComponent, MaterialMove
from app.models.part_counts import PartCountLine
from app.models.part_units import PartReservation, PartUnit, PartUnitEvent
from app.models.prices import ItemPrice
from app.models.production import ProductModel, ProductModelPart, ProductionTaskLine
from app.models.production_orders import ProductionOrderLine
from app.services.item_aliases import add_alias, alias_key


class MergeError(ValueError):
    pass


@dataclass
class MergeReport:
    src: str
    dst: str
    moved: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    notes: list[str] = field(default_factory=list)


def _stage_map(db: Session, src_item: Item, dst_item: Item) -> dict[int, int | None]:
    src = db.query(PartStage).filter(PartStage.item_id == src_item.id).order_by(PartStage.sequence_order).all()
    dst = db.query(PartStage).filter(PartStage.item_id == dst_item.id).order_by(PartStage.sequence_order).all()
    out: dict[int, int | None] = {}
    for s in src:
        hit = next((d for d in dst if d.sequence_order == s.sequence_order), None) or next(
            (d for d in dst if d.name.strip().lower() == s.name.strip().lower()), None
        )
        out[s.id] = hit.id if hit else None
    return out


def merge_items(db: Session, src: Item, dst: Item, user_id: int) -> MergeReport:
    """Слить src в dst. Пишет в сессию, не коммитит (пробный прогон —
    откатить снаружи)."""
    if src.id == dst.id:
        raise MergeError("Нельзя слить позицию саму с собой")
    if src.kind_id != dst.kind_id:
        raise MergeError("Позиции разных видов — сливать нельзя")
    if src.is_model or dst.is_model:
        raise MergeError("Модели не сливаются — сливайте варианты")
    if db.query(MaterialSku.id).filter(MaterialSku.item_id.in_([src.id, dst.id])).first():
        raise MergeError("Плёнка сливается кнопкой «Объединить» в карточке плёнки")
    if db.query(ProductModel.id).filter(ProductModel.item_id.in_([src.id, dst.id])).first():
        raise MergeError("Модели продукции (BOM) не сливаются")
    sp = db.query(Part).filter(Part.item_id == src.id).first()
    dp = db.query(Part).filter(Part.item_id == dst.id).first()
    if (sp is None) != (dp is None):
        raise MergeError("Одна позиция — деталь п/ф, другая нет")
    rep = MergeReport(src=src.name, dst=dst.name)
    m = rep.moved

    # этапы: ссылки на этапы дубля — на этапы основной
    smap = _stage_map(db, src, dst)
    refs = [
        (PartUnit, PartUnit.stage_id, "партии"),
        (PartUnitEvent, PartUnitEvent.from_stage_id, None),
        (PartUnitEvent, PartUnitEvent.to_stage_id, None),
        (ProductionTaskLine, ProductionTaskLine.part_stage_id, "строки заданий (этап)"),
        (PartCountLine, PartCountLine.stage_id, None),
        (ItemComponent, ItemComponent.stage_id, None),
    ]
    missing = []
    for sid, did in smap.items():
        used = any(db.query(model.id).filter(col == sid).first() for model, col, _ in refs)
        if did is None and used:
            missing.append(db.get(PartStage, sid).name)
    if missing:
        raise MergeError(f"У «{dst.name}» нет этапов: {', '.join(missing)} — добавьте их в маршрут основной позиции")
    for sid, did in smap.items():
        if did is None:
            continue
        for model, col, _label in refs:
            db.query(model).filter(col == sid).update({col: did}, synchronize_session=False)

    if sp is not None:
        # резервы: одна запись на (задание, деталь) — складываем
        for r in db.query(PartReservation).filter(PartReservation.part_id == sp.id).all():
            ex = db.query(PartReservation).filter(PartReservation.task_id == r.task_id, PartReservation.part_id == dp.id).first()
            if ex is not None:
                ex.quantity_pieces = float(ex.quantity_pieces) + float(r.quantity_pieces)
                db.delete(r)
            else:
                r.part_id = dp.id
            m["резервы"] += 1
        for model, col, label in (
            (PartUnit, PartUnit.part_id, "партии"),
            (ProductionTaskLine, ProductionTaskLine.part_id, "строки заданий"),
            (ProductModelPart, ProductModelPart.part_id, "строки BOM"),
            (PartCountLine, PartCountLine.part_id, "строки пересчёта"),
            (ItemTypeComponent, ItemTypeComponent.route_part_id, "правила типов"),
        ):
            n = db.query(model).filter(col == sp.id).update({col: dp.id}, synchronize_session=False)
            if n:
                m[label] += n

    for model, col, label in (
        (ProductionOrderLine, ProductionOrderLine.item_id, "строки заказов на производство"),
        (CustomerOrderLine, CustomerOrderLine.item_id, "строки заказов клиентов"),
        (MaterialMove, MaterialMove.item_id, "движения материала"),
        (FgMove, FgMove.item_id, "движения склада ГП"),
        (ItemPrice, ItemPrice.item_id, "цены"),
        (Item, Item.base_item_id, "детали в плёнке от неё"),
    ):
        n = db.query(model).filter(col == src.id).update({col: dst.id}, synchronize_session=False)
        if n:
            m[label] += n

    # где дубль — комплектующее: на основную; уже есть та же строка — складываем
    for c in db.query(ItemComponent).filter(ItemComponent.component_item_id == src.id).all():
        ex = db.query(ItemComponent).filter(
            ItemComponent.parent_item_id == c.parent_item_id, ItemComponent.component_item_id == dst.id,
            ItemComponent.stage_id == c.stage_id, ItemComponent.id != c.id,
        ).first()
        if ex is not None:
            ex.qty_per_unit = float(ex.qty_per_unit) + float(c.qty_per_unit)
            db.delete(c)
        else:
            c.component_item_id = dst.id
        m["в составе других позиций"] += 1

    # синонимы дубля и его название — синонимы основной
    for a in db.query(ItemAlias).filter(ItemAlias.item_id == src.id).all():
        if a.alias == alias_key(dst.name):
            db.delete(a)
        else:
            a.item_id = dst.id
            m["синонимы"] += 1
    db.flush()
    old_name = src.name
    mark = f" [дубль → №{dst.id}]"
    src.name = (old_name + mark)[:255]
    src.is_active = False
    if sp is not None:
        sp.name = (sp.name + mark)[:255]
        sp.is_active = False
    db.flush()
    try:
        add_alias(db, dst, old_name, source="слияние дублей", user_id=user_id)
    except ValueError:
        rep.notes.append(f"Название «{old_name}» уже синоним другой позиции — синонимом не записано")
    rep.notes.append(f"«{old_name}» — в архив; её название — синоним «{dst.name}»")
    return rep
