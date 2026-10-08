"""Ручная правка запуска (02.10): в раскладке перед запуском можно поправить
любую строку, что родится, — количество, программу станка, указание мастеру,
плёнку, ширину штрипса, участок или «не делать этот этап». Правки
применяются к только что созданным строкам заданий (тот же вызов и для
раскладки, и для настоящего запуска), в строке остаётся, что поменяли и кто.

Ключ строки — «строка заказа : деталь : операция»: одинаков в раскладке и в
запуске, не зависит от участка (участок как раз можно поменять). Строка п/ф,
объединённая из нескольких (services/release_merge.py), — составной ключ
«k1|k2|…»: правка идёт всем её строкам, изменение количества — последней."""

from dataclasses import dataclass
from datetime import date

from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.dictionaries import MaterialSku
from app.models.production import ProductionTask, ProductionTaskLine
from app.models.production_orders import ProductionOrder


@dataclass
class LineOverride:
    key: str
    quantity: float | None = None
    program: str | None = None
    instruction: str | None = None
    material_sku_id: int | None = None
    strip_width_mm: float | None = None
    area: str | None = None
    skip: bool = False


def line_key(ln: ProductionTaskLine) -> str:
    return f"{ln.order_line_id or 0}:{ln.part_id or 0}:{ln.part_stage_id or 0}"


def _distribute_quantity(lines: list[ProductionTaskLine], total: float, stamp: str) -> None:
    """Объединённая строка: новое общее количество — разница уходит в
    последние строки (уменьшение — с конца, не ниже нуля)."""
    current = sum(float(ln.quantity_pieces) for ln in lines)
    diff = round(total - current, 4)
    if abs(diff) < 1e-9:
        return
    for ln in reversed(lines):
        q = float(ln.quantity_pieces)
        new = max(0.0, q + diff)
        diff -= new - q
        if new != q:
            ln.quantity_pieces = new
            ln.manual_changes = [*(ln.manual_changes or []), f"кол-во {q:g} → {new:g} (общая строка) · {stamp}"]
        if abs(diff) < 1e-9:
            break


def apply_overrides(
    db: Session, order: ProductionOrder, overrides: list[LineOverride], user_name: str, keep_skipped: set[str] | None = None
) -> list[str]:
    """Применить правки (без commit). Возвращает ошибки (ключ не найден и т.п.).
    keep_skipped — предпросмотр раскладки: строки «не делать» не удаляются,
    их ключи собираются сюда (черновик показывает их серыми, 07.10)."""
    if not overrides:
        return []
    tasks = db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id).all()
    by_key: dict[str, list[ProductionTaskLine]] = {}
    for t in tasks:
        for ln in t.lines:
            by_key.setdefault(line_key(ln), []).append(ln)
    stamp = f"{user_name}, {date.today().strftime('%d.%m')}"
    errors: list[str] = []
    for ov in overrides:
        members = ov.key.split("|")
        lines = [ln for k in members for ln in by_key.get(k, [])]
        if not lines:
            errors.append(f"строка {ov.key} не найдена — раскладка изменилась, проверьте правки")
            continue
        if len(members) > 1 and ov.quantity is not None and not ov.skip:
            _distribute_quantity(lines, float(ov.quantity), stamp)
            ov = LineOverride(**{**ov.__dict__, "quantity": None})
        for ln in lines:
            changes: list[str] = []
            if ov.skip and keep_skipped is not None:
                keep_skipped.add(line_key(ln))
                continue
            if ov.skip:
                task = ln.task
                task.lines.remove(ln)
                db.delete(ln)
                db.flush()
                if not task.lines:
                    db.delete(task)
                continue
            if ov.quantity is not None and float(ov.quantity) != float(ln.quantity_pieces):
                changes.append(f"кол-во {float(ln.quantity_pieces):g} → {float(ov.quantity):g}")
                ln.quantity_pieces = ov.quantity
            if ov.program is not None and (ov.program or None) != ln.program:
                ln.program = ov.program.strip() or None
                changes.append(f"программа {ln.program or '—'}")
            if ov.instruction is not None and (ov.instruction or None) != ln.instruction:
                ln.instruction = ov.instruction.strip()[:255] or None
            if ov.material_sku_id is not None:
                sku = db.get(MaterialSku, ov.material_sku_id)
                if sku is None:
                    errors.append(f"плёнка {ov.material_sku_id} не найдена")
                elif (sku.material_id, sku.color_id, sku.thickness_id) != (ln.material_id, ln.color_id, ln.thickness_id):
                    ln.material_id, ln.color_id, ln.thickness_id = sku.material_id, sku.color_id, sku.thickness_id
                    changes.append(f"плёнка {sku.material.name} {sku.color.name} {float(sku.thickness.value_mm):g}")
            if ov.strip_width_mm is not None and float(ov.strip_width_mm) != float(ln.strip_width_mm or 0):
                changes.append(f"штрипс {float(ln.strip_width_mm or 0):g} → {float(ov.strip_width_mm):g} мм")
                ln.strip_width_mm = ov.strip_width_mm
            if ov.area and ov.area != ln.task.area:
                area = db.get(Area, ov.area)
                if area is None:
                    errors.append(f"участок {ov.area} не найден")
                else:
                    src = ln.task
                    dst = next((t for t in tasks if t.area == ov.area and t.for_task_id == src.for_task_id and t in db), None)
                    if dst is None:
                        dst = ProductionTask(
                            name=f"Заказ №{order.id} «{order.name}» — {'п/ф, ' if src.for_task_id else ''}{area.name}"[:255],
                            area=ov.area, created_by=src.created_by, production_order_id=order.id, is_active=True,
                            for_task_id=src.for_task_id,
                        )
                        db.add(dst)
                        tasks.append(dst)
                    src.lines.remove(ln)
                    dst.lines.append(ln)
                    changes.append(f"участок {area.name}")
                    db.flush()
                    if not src.lines:
                        db.delete(src)
            if changes:
                ln.manual_changes = [*(ln.manual_changes or []), f"{'; '.join(changes)} · {stamp}"]
    db.flush()
    return errors
