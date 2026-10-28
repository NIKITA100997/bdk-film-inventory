"""Исполнение в строке заказа (26.10).

Свойство типа с ролью «исполнение» (цвет кромки, тип стекла, цвет молдинга)
не задаёт позицию номенклатуры: в позицию — только конструкция (то, что
меняет маршрут и состав), а исполнение — список выборов строки заказа
[{code, name, value, op}]. Из счёта 1С берётся то, что есть в строке,
остальное дописывают на следующем этапе (заказ, запуск). При запуске выборы
уходят указанием мастеру в строки заданий своей операции (op; пусто — всем).

Цвет уплотнителя коробок (погонаж, без типа) — тоже исполнение, из скобок
счёта («серо-белый УК-6»)."""

from sqlalchemy.orm import Session

from app.models.items import ItemPropertyOption, ItemType

EXECUTION = "execution"
SEAL = {"code": "уплотнитель", "name": "Уплотнитель", "op": None}


def is_execution(p) -> bool:
    return (getattr(p, "role", None) or "construction") == EXECUTION


def _display(db: Session, p, raw) -> str | None:
    if raw is None or raw == "":
        return None
    if p.value_type == "list":
        opt = db.get(ItemPropertyOption, int(raw)) if isinstance(raw, int) or str(raw).isdigit() else None
        return (opt.label or opt.value) if opt else str(raw)
    if p.value_type == "bool":
        return "да" if raw else None
    if p.value_type == "number":
        return f"{float(raw):g}"
    return " ".join(str(raw).split()) or None


def split_values(db: Session, type_: ItemType, values: dict[int, object]) -> tuple[dict[int, object], list[dict]]:
    """Значения свойств → (конструкция — для позиции, исполнение — для строки)."""
    props = {p.id: p for p in type_.properties}
    keep: dict[int, object] = {}
    opts: list[dict] = []
    for pid, v in values.items():
        p = props.get(pid)
        if p is not None and is_execution(p):
            shown = _display(db, p, v)
            if shown:
                opts.append({"code": p.code, "name": p.name, "value": shown, "op": p.operation})
        else:
            keep[pid] = v
    return keep, opts


def seal_option(name_text: str) -> list[dict]:
    from app.services.schedule_import import seal_of

    s = seal_of(name_text or "")
    return [{**SEAL, "value": s}] if s else []


def merge(base: list[dict] | None, extra: list[dict] | None) -> list[dict]:
    """Выборы строки: extra поверх base по коду."""
    out = {o["code"]: dict(o) for o in (base or []) if o.get("code")}
    for o in extra or []:
        if o.get("code"):
            if (o.get("value") or "").strip():
                out[o["code"]] = dict(o)
            else:
                out.pop(o["code"], None)
    return list(out.values())


def text(opts: list[dict] | None) -> str:
    return "; ".join(f"{o['name'].lower()}: {o['value']}" for o in (opts or []) if o.get("value"))


def key(opts: list[dict] | None) -> str:
    """Ключ для сравнения строк (повторная загрузка счёта)."""
    return "|".join(sorted(f"{o['code']}={str(o.get('value') or '').strip().lower()}" for o in (opts or []) if o.get("value")))


def instruction_for(opts: list[dict] | None, operation: str | None) -> str:
    """Указание мастеру на операции: выборы этой операции и без операции."""
    hit = [o for o in (opts or []) if o.get("value") and (not o.get("op") or (operation and o["op"].strip().lower() == operation.strip().lower()))]
    return text(hit)


def type_execution_props(type_: ItemType | None) -> list[dict]:
    """Какие выборы есть у типа — для редактора строки."""
    if type_ is None:
        return []
    return [
        {"code": p.code, "name": p.name, "op": p.operation, "value_type": p.value_type,
         "options": [o.label or o.value for o in p.options if o.is_active] if p.value_type == "list" else []}
        for p in type_.properties if is_execution(p)
    ]


def _pick_op(op: str | None, have: set[str]) -> str | None:
    """Операция выбора у этой позиции: список по приоритету («Кромка, Сборка»)
    — первая, что есть в маршруте; ни одной нет — всем операциям (None)."""
    for o in (op or "").replace("/", ",").split(","):
        if o.strip() and o.strip().lower() in have:
            return o.strip()
    return None


def apply_to_tasks(db: Session, order) -> int:
    """Запуск: выборы строк заказа — указанием мастеру в строки заданий
    своей операции (не затирая ручное указание). Возвращает число строк."""
    from app.models.dictionaries import PartStage
    from app.models.production import ProductionTask, ProductionTaskLine
    from app.models.production_orders import ProductionOrderLine

    lines = {ol.id: ol for ol in db.query(ProductionOrderLine).filter(ProductionOrderLine.order_id == order.id) if ol.options}
    if not lines:
        return 0
    n = 0
    tls = (
        db.query(ProductionTaskLine)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTask.production_order_id == order.id, ProductionTaskLine.order_line_id.in_(list(lines)))
    )
    tls = [tl for tl in tls if tl.part_id is None]  # детали п/ф — без исполнения двери
    stage_name = {tl.id: (db.get(PartStage, tl.part_stage_id).name if tl.part_stage_id else None) for tl in tls}
    # операции каждой строки заказа: выбор, чьей операции у позиции нет
    # (цвет кромки у двери с алюм. профилем — без «Кромки»), — всем её строкам
    # операция выбора — из актуальной настройки типа позиции (поменяли — действует и на загруженные строки)
    from app.models.items import Item

    op_cfg: dict[int, dict[str, str | None]] = {}
    for ol_id, ol in lines.items():
        it = db.get(Item, ol.item_id)
        if it is not None and it.type is not None:
            op_cfg[ol_id] = {p.code: p.operation for p in it.type.properties if is_execution(p)}
    ops_of: dict[int, set[str]] = {}
    for tl in tls:
        if stage_name[tl.id]:
            ops_of.setdefault(tl.order_line_id, set()).add(stage_name[tl.id].strip().lower())
    for tl in tls:
        have = ops_of.get(tl.order_line_id, set())
        cfg = op_cfg.get(tl.order_line_id, {})
        opts = [{**o, "op": _pick_op(cfg.get(o.get("code"), o.get("op")), have)} for o in lines[tl.order_line_id].options]
        add = instruction_for(opts, stage_name[tl.id])
        # прежние выборы в указании — заменить (поправили выбор у запущенного заказа)
        names = {o["name"].strip().lower() + ":" for o in lines[tl.order_line_id].options if o.get("name")}
        keep = [s.strip() for s in (tl.instruction or "").split(";") if s.strip() and not any(s.strip().lower().startswith(nm) for nm in names)]
        new = "; ".join(keep + ([add] if add else []))[:255] or None
        if new != (tl.instruction or None):
            tl.instruction = new
            n += 1
    return n


def option_fields(db: Session, item) -> list[dict]:
    """Выборы, которые можно задать строке с этой позицией: исполнение типа,
    у коробки с уплотнителем — цвет уплотнителя."""
    if item is None:
        return []
    # кэш на сессию (один запрос — одна сессия), как item_chars_cached: список
    # заказов спрашивает одну и ту же позицию в десятках строк (28.10)
    cache = db.info.setdefault("option_fields", {})
    if item.id is not None and item.id in cache:
        return [dict(f) for f in cache[item.id]]
    out = _option_fields(db, item)
    if item.id is not None:
        cache[item.id] = out
    return [dict(f) for f in out]


def _option_fields(db: Session, item) -> list[dict]:
    out = type_execution_props(item.type) if item.type_id else []
    if out and item.type is not None:
        # уместно, только если у позиции есть то, к чему выбор: «тип_стекла» —
        # при «стекло», «цвет_молдинга» — при «молдинг» (код после «_»)
        from app.services.type_rules import context_from_values, item_values

        ctx = context_from_values(db, item.type, item_values(db, item))
        def base(code: str) -> str | None:
            # «тип_стекла» → «стекло», «цвет_молдинга» → «молдинг», «цвет_кромки» → «кромка» (по основе)
            if "_" not in code:
                return None
            tail = code.split("_", 1)[1]
            return next((k for k in ctx if len(k) > 3 and k != code and tail.startswith(k[:-1])), None)

        out = [f for f in out if (b := base(f["code"])) is None or bool(ctx.get(b))]
    if "упл" in (item.name or "").lower() and not any(f["code"] == SEAL["code"] for f in out):
        out.append({**SEAL, "value_type": "text", "options": []})
    return out
