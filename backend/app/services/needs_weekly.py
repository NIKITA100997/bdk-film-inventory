"""Потребность по неделям (22.10): сколько плёнки и материалов нужно
открытым заказам (заказы клиентов и заказы на производство) на эту
неделю, следующую и дальше, и хватит ли.

Нужно — по дням операций заказа (запущенный — по плану, незапущенный —
пробный запуск, как в «Дефиците по заказам»), неделя с понедельника.
Прогноз остатка к концу недели: склад + заявки на закупку с датой поставки
до конца недели − нужно нарастающим итогом. Заявки без даты поставки в
прогноз не входят — отдельный столбец «Заказано (без даты)»."""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy.orm import Session

from app.services.order_needs import compute, film_stock_m2, incoming_lots

OVERDUE = "overdue"
LATER = "later"
NODATE = "nodate"


@dataclass
class Bucket:
    key: str
    label: str
    start: date | None
    end: date | None


@dataclass
class Cell:
    need: float = 0.0
    balance: float | None = None  # прогноз остатка на конец периода
    orders: list[dict] = field(default_factory=list)


@dataclass
class WeekRow:
    kind: str
    key: str
    name: str
    unit: str
    stock: float
    incoming_undated: float
    total_need: float = 0.0
    cells: dict[str, Cell] = field(default_factory=dict)
    first_short: str | None = None  # первый период, где прогноз уходит в минус


def buckets(today: date, weeks: int) -> list[Bucket]:
    w0 = today - timedelta(days=today.weekday())
    out = [Bucket(OVERDUE, "Просрочено", None, w0 - timedelta(days=1))]
    for i in range(weeks):
        s = w0 + timedelta(weeks=i)
        e = s + timedelta(days=6)
        name = "Эта неделя" if i == 0 else "След. неделя" if i == 1 else f"Через {i} нед."
        out.append(Bucket(s.isoformat(), f"{name} · {s:%d.%m}–{e:%d.%m}", s, e))
    out.append(Bucket(LATER, "Позже", w0 + timedelta(weeks=weeks), None))
    out.append(Bucket(NODATE, "Без даты", None, None))
    return out


def bucket_of(d: date | None, bs: list[Bucket]) -> str:
    if d is None:
        return NODATE
    for b in bs:
        if b.key in (NODATE,):
            continue
        if (b.start is None or d >= b.start) and (b.end is None or d <= b.end):
            return b.key
    return LATER


def weekly(db: Session, user_id: int, weeks: int = 6, today: date | None = None) -> tuple[list[Bucket], list[WeekRow]]:
    from app.services.materials import balances as material_balances

    bs = buckets(today or date.today(), weeks)
    needs = compute(db, user_id)
    film_stock = film_stock_m2(db)
    incoming = incoming_lots(db)

    rows: dict[str, WeekRow] = {}
    for on in needs:
        for r in on.rows:
            row = rows.get(r.key)
            if row is None:
                row = rows[r.key] = WeekRow(kind=r.kind, key=r.key, name=r.name, unit=r.unit, stock=0.0, incoming_undated=0.0)
            per: dict[str, float] = defaultdict(float)
            for d, q in (r.by_date or {None: r.need}).items():
                per[bucket_of(d, bs)] += q
            for bk, q in per.items():
                if q <= 0.0005:
                    continue
                c = row.cells.setdefault(bk, Cell())
                c.need += q
                c.orders.append({"order_id": on.order_id, "customer_order_id": on.customer_order_id, "name": on.name, "need": round(q, 3)})
                row.total_need += q

    item_ids = [int(k.split(":")[1]) for k in rows if k.startswith("item:")]
    mat = material_balances(db, item_ids) if item_ids else {}
    for key, row in rows.items():
        row.stock = round(film_stock.get(key, 0.0) if row.kind == "film" else float(mat.get(int(key.split(":")[1]), 0.0)), 3)
        lots = incoming.get(key, [])
        row.incoming_undated = round(sum(q for q, d in lots if d is None), 3)
        dated = [(q, d) for q, d in lots if d is not None]
        bal = row.stock
        for b in bs:
            if b.key == NODATE:
                continue
            # поставки, пришедшие к концу периода (у «Позже» — все с датой)
            arrive = [x for x in dated if b.end is None or x[1] <= b.end]
            bal += sum(q for q, _ in arrive)
            dated = [x for x in dated if x not in arrive]
            c = row.cells.get(b.key)
            if c is not None:
                bal -= c.need
            if c is not None or b.start is not None:
                cc = row.cells.setdefault(b.key, Cell())
                cc.balance = round(bal, 3)
                if bal < -0.0005 and row.first_short is None:
                    row.first_short = b.key
        nd = row.cells.get(NODATE)
        if nd is not None:
            bal -= nd.need
            nd.balance = round(bal, 3)
            if bal < -0.0005 and row.first_short is None:
                row.first_short = NODATE
        for c in row.cells.values():
            c.need = round(c.need, 3)
        row.total_need = round(row.total_need, 3)

    order = {b.key: i for i, b in enumerate(bs)}
    out = sorted(rows.values(), key=lambda r: (order.get(r.first_short, 99), r.kind != "film", r.name))
    return bs, out
