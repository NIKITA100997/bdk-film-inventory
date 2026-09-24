"""Состав позиции (единая модель, пункт 3 — спецификация): из чего состоит
позиция, для любого вида номенклатуры.

Источники строк состава (ItemComponent.source):
  • "bom" — перенесено из BOM модели изделия (ProductModelPart), пока BOM
    правится на прежнем экране моделей: строки, связанные с деталью,
    держатся в составе синхронно (sync_bom_components);
  • "manual" — заведено в техкарте вручную;
  • "rule" — по правилам состава типа изделия (следующий шаг).
Синхронизация трогает только свой источник."""

from collections import defaultdict

from sqlalchemy.orm import Session

from app.models.dictionaries import Part
from app.models.items import ItemComponent
from app.models.production import ProductModel, ProductModelPart


def sync_bom_components(db: Session, model_ids: set[int] | list[int]) -> None:
    """Привести строки состава "bom" изделий к их BOM (без commit). Вызывать
    после flush — чтобы автосвязь строк с деталями уже отработала."""
    for model_id in set(model_ids):
        model = db.get(ProductModel, model_id)
        if model is None or model.item_id is None:
            continue
        qty: dict[int, float] = defaultdict(float)
        order: list[int] = []
        for line in db.query(ProductModelPart).filter(
            ProductModelPart.product_model_id == model_id, ProductModelPart.part_id.isnot(None)
        ).order_by(ProductModelPart.id):
            part = db.get(Part, line.part_id)
            if part is None or part.item_id is None:
                continue
            if part.item_id not in qty:
                order.append(part.item_id)
            qty[part.item_id] += float(line.qty_per_unit)
        existing = {
            c.component_item_id: c
            for c in db.query(ItemComponent).filter(
                ItemComponent.parent_item_id == model.item_id, ItemComponent.source == "bom"
            )
        }
        for comp_id, c in existing.items():
            if comp_id not in qty:
                db.delete(c)
        for i, comp_id in enumerate(order, start=1):
            c = existing.get(comp_id)
            if c is None:
                db.add(
                    ItemComponent(
                        parent_item_id=model.item_id, component_item_id=comp_id, qty_per_unit=qty[comp_id],
                        source="bom", sort_order=i,
                    )
                )
            else:
                c.qty_per_unit = qty[comp_id]
                c.sort_order = i
    db.flush()


def models_of_bom_lines(lines: list[ProductModelPart]) -> set[int]:
    return {line.product_model_id for line in lines}
