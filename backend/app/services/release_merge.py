"""Объединение строк п/ф при запуске заказа (08.10.2026).

release_pf рождает строку на «строку заказа × деталь × операция», поэтому
один и тот же каркас 24×810×2010 у трёх строк заказа разного цвета шёл
участку тремя строками (в «Графике» сборка каркасов — 32 строки на 8
каркасов). П/ф расходуются по FIFO по участку, без привязки к строке
заказа, — такие строки сливаются в одну: та же деталь, операция, плёнка,
ширина штрипса, программа и указание мастеру. Количество суммируется;
строка заказа остаётся, только если она у всех одна.

Не трогает: строки самой позиции заказа (двери, погонаж под заказ — им нужна
связь со строкой заказа: ход заказа, приход на склад готовой по счёту) и
строки «не делать» в предпросмотре.

Вызывается после ручных правок и до сроков (release, release-layout).
Возвращает для предпросмотра: id объединённой строки → ключи её строк
(составной ключ «k1|k2|…» — по нему черновик правит объединённую строку)."""

from sqlalchemy.orm import Session

from app.models.dictionaries import Part
from app.models.production import ProductionTask, ProductionTaskLine
from app.models.production_orders import ProductionOrder, ProductionOrderLine
from app.services.release_overrides import line_key


def _merge_key(ln: ProductionTaskLine) -> tuple:
    f = lambda v: None if v is None else round(float(v), 3)  # noqa: E731
    return (
        ln.part_id, ln.part_stage_id, ln.material_id, ln.color_id, ln.thickness_id, f(ln.strip_width_mm), f(ln.length_m),
        ln.program or None, ln.instruction or None,
    )


def merge_pf_lines(db: Session, order: ProductionOrder, skipped: set[str] | None = None) -> dict[int, list[str]]:
    skipped = skipped or set()
    ol_item = {ol.id: ol.item_id for ol in db.query(ProductionOrderLine).filter(ProductionOrderLine.order_id == order.id)}
    part_item = {}
    merged_keys: dict[int, list[str]] = {}
    for task in db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id).order_by(ProductionTask.id):
        groups: dict[tuple, list[ProductionTaskLine]] = {}
        for ln in sorted(task.lines, key=lambda x: x.id or 0):
            if ln.part_id is None or line_key(ln) in skipped:
                continue
            if ln.part_id not in part_item:
                p = db.get(Part, ln.part_id)
                part_item[ln.part_id] = p.item_id if p else None
            if ln.order_line_id and ol_item.get(ln.order_line_id) == part_item[ln.part_id]:
                continue  # строка самой позиции заказа
            groups.setdefault(_merge_key(ln), []).append(ln)
        for lines in groups.values():
            if len(lines) < 2:
                continue
            keep, rest = lines[0], lines[1:]
            keys = [line_key(x) for x in lines]
            keep.quantity_pieces = round(sum(float(x.quantity_pieces) for x in lines), 2)
            if len({x.order_line_id for x in lines}) > 1:
                keep.order_line_id = None
            notes = [c for x in lines for c in (x.manual_changes or [])]
            if notes:
                keep.manual_changes = list(dict.fromkeys(notes))
            for x in rest:
                task.lines.remove(x)
                db.delete(x)
            merged_keys[keep.id] = keys
    db.flush()
    return merged_keys
