"""Единый журнал движений партий (08.10.2026) — представление lot_movements
(миграция b5d7f9a1c3e4) поверх четырёх журналов: плёнка, п/ф, материалы,
готовые изделия. Таблицы у видов остаются свои; для людей и отчётов
журнал один: дата, партия (ПЛ-…/ПФ-…), позиция, операция, количество,
сумма, кто, участок, задание."""

from dataclasses import dataclass
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from sqlalchemy import Column, DateTime, Integer, MetaData, Numeric, String, Table, func, select
from sqlalchemy.orm import Session

from app.models.events import EventType
from app.models.part_units import PartEventType

TZ = ZoneInfo("Europe/Moscow")

# Своя MetaData: это представление, create_all его создавать не должен.
lot_movements = Table(
    "lot_movements",
    MetaData(),
    Column("kind", String),
    Column("src_id", Integer),
    Column("lot_id", Integer),
    Column("item_id", Integer),
    Column("occurred_at", DateTime(timezone=True)),
    Column("op", String),
    Column("qty", Numeric),
    Column("unit", String),
    Column("qty_m2", Numeric),
    Column("amount_rub", Numeric),
    Column("area", String),
    Column("cell_from", String),
    Column("cell_to", String),
    Column("user_id", Integer),
    Column("task_line_id", Integer),
    Column("reason", String),
    Column("note", String),
    Column("to_length", Numeric),
    Column("stage_from", Integer),
    Column("stage_to", Integer),
)

KIND_LABEL = {"film": "Плёнка", "pf": "П/ф", "material": "Материал", "fg": "Готовое изделие"}
LOT_PREFIX = {"film": "ПЛ", "pf": "ПФ"}
_MATERIAL_OPS = {"receipt": "Приход", "consumption": "Расход в производство", "writeoff": "Списание", "adjust": "Инвентаризация"}
_FG_OPS = {
    "receipt": "Приход (упаковка)", "shipment": "Отгрузка", "unship": "Отмена отгрузки", "adjust": "Корректировка",
    "transfer": "Перемещение", "return": "Возврат от клиента",
}


def op_label(kind: str, op: str) -> str:
    try:
        if kind == "film":
            return EventType[op].value.replace("_", " ")
        if kind == "pf":
            return PartEventType[op].value.replace("_", " ")
    except KeyError:
        return op
    if kind == "material":
        return _MATERIAL_OPS.get(op, op)
    if kind == "fg":
        return _FG_OPS.get(op, op)
    return op


def op_options() -> list[tuple[str, str, str]]:
    """(вид, код, подпись) — для фильтра «Операция»."""
    out = [("film", e.name, op_label("film", e.name)) for e in EventType]
    out += [("pf", e.name, op_label("pf", e.name)) for e in PartEventType]
    out += [("material", k, v) for k, v in _MATERIAL_OPS.items()]
    out += [("fg", k, v) for k, v in _FG_OPS.items()]
    return out


def lot_no(kind: str, lot_id: int | None) -> str | None:
    if lot_id is None or kind not in LOT_PREFIX:
        return None
    return f"{LOT_PREFIX[kind]}-{lot_id}"


def parse_lot(text: str) -> tuple[str | None, int] | None:
    """«ПЛ-1015», «пф 193», «1015» → (вид или None, номер)."""
    t = text.strip().upper().replace(" ", "").replace("-", "")
    for kind, prefix in LOT_PREFIX.items():
        if t.startswith(prefix) and t[len(prefix):].isdigit():
            return kind, int(t[len(prefix):])
    return (None, int(t)) if t.isdigit() else None


@dataclass
class Filters:
    date_from: date
    date_to: date
    kinds: list[str] | None = None
    item_id: int | None = None
    lot: str | None = None
    area: str | None = None
    user_id: int | None = None
    ops: list[str] | None = None  # «вид:код»
    task_line_id: int | None = None
    only_qty: bool = True  # без событий без количества (донор предложен, привязка…)


def _where(f: Filters):
    m = lot_movements.c
    start = datetime.combine(f.date_from, time.min, tzinfo=TZ)
    end = datetime.combine(f.date_to, time.max, tzinfo=TZ)
    conds = [m.occurred_at >= start, m.occurred_at <= end]
    if f.kinds:
        conds.append(m.kind.in_(f.kinds))
    if f.item_id is not None:
        conds.append(m.item_id == f.item_id)
    if f.lot:
        parsed = parse_lot(f.lot)
        if parsed is None:
            conds.append(m.lot_id == -1)
        else:
            kind, n = parsed
            conds.append(m.lot_id == n)
            if kind:
                conds.append(m.kind == kind)
    if f.area:
        conds.append(m.area == f.area)
    if f.user_id is not None:
        conds.append(m.user_id == f.user_id)
    if f.task_line_id is not None:
        conds.append(m.task_line_id == f.task_line_id)
    if f.ops:
        from sqlalchemy import and_, or_

        pairs = [o.split(":", 1) for o in f.ops if ":" in o]
        if pairs:
            conds.append(or_(*[and_(m.kind == k, m.op == c) for k, c in pairs]))
    if f.only_qty:
        conds.append(m.qty != 0)
    return conds


def query_rows(db: Session, f: Filters, limit: int, offset: int):
    m = lot_movements.c
    q = select(lot_movements).where(*_where(f)).order_by(m.occurred_at.desc(), m.kind, m.src_id.desc()).limit(limit).offset(offset)
    return db.execute(q).mappings().all()


def totals(db: Session, f: Filters) -> tuple[int, list[dict]]:
    """Сколько строк и итоги по виду и единице: приход (+), расход (−), сумма."""
    m = lot_movements.c
    total = db.execute(select(func.count()).select_from(lot_movements).where(*_where(f))).scalar() or 0
    rows = db.execute(
        select(
            m.kind, m.unit,
            func.coalesce(func.sum(func.greatest(m.qty, 0)), 0),
            func.coalesce(func.sum(func.least(m.qty, 0)), 0),
            func.sum(m.amount_rub),
            func.count(m.amount_rub),
            func.count(),
        ).where(*_where(f)).group_by(m.kind, m.unit)
    ).all()
    return total, [
        {
            "kind": k, "unit": u, "qty_in": float(pin), "qty_out": float(pout),
            "amount_rub": float(a) if a is not None else None, "priced": int(np), "rows": int(n),
        }
        for k, u, pin, pout, a, np, n in rows
    ]
