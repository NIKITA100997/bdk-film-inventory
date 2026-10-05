"""Цены позиций (05.10, models/prices.py): действующая цена на дату и её
пересчёт в рубли по общему курсу; загрузка цен из 1С.

Единица цены: у плёнки — «м²» (поставщики дают за м²), можно «м» (погонный
метр рулона её родной ширины); у остальных — единица позиции."""

import re
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy.orm import Session

from app.models.items import Item, item_unit, normalize_name
from app.models.prices import PRICE_1C, Currency, ItemPrice

RUB = "RUB"


def default_unit(item: Item) -> str:
    if item.price_unit:
        return item.price_unit
    return "м²" if item.kind.code == "plenka" else item_unit(item)


def default_currency(item: Item) -> str:
    return item.price_currency or RUB


def rates(db: Session) -> dict[str, float | None]:
    out: dict[str, float | None] = {c.code: (float(c.rate) if c.rate is not None else None) for c in db.query(Currency)}
    out[RUB] = 1.0
    return out


def current_price(db: Session, item_id: int, at: date | None = None) -> ItemPrice | None:
    q = db.query(ItemPrice).filter(ItemPrice.item_id == item_id)
    if at is not None:
        q = q.filter(ItemPrice.valid_from <= at)
    return q.order_by(ItemPrice.valid_from.desc(), ItemPrice.id.desc()).first()


@dataclass
class PriceRub:
    """Цена в рублях за единицу (unit) и откуда она."""

    rub: float
    unit: str
    price: ItemPrice


def price_rub(db: Session, item_id: int, at: date | None = None, rate_map: dict | None = None) -> PriceRub | None:
    """Цена в рублях на дату по общему курсу. Нет цены или курса — None."""
    p = current_price(db, item_id, at)
    if p is None:
        return None
    r = (rate_map if rate_map is not None else rates(db)).get(p.currency)
    if r is None:
        return None
    return PriceRub(rub=float(p.price) * r, unit=p.unit, price=p)


def film_rub_per_m2(db: Session, sku_item_id: int, native_width_mm: float | None, at: date | None = None,
                    rate_map: dict | None = None) -> float | None:
    """Плёнка: рублей за м² — цена за м² как есть, за погонный метр —
    делится на родную ширину рулона."""
    pr = price_rub(db, sku_item_id, at, rate_map)
    if pr is None:
        return None
    if pr.unit == "м²":
        return pr.rub
    if pr.unit in ("м", "м.п.") and native_width_mm:
        return pr.rub / (float(native_width_mm) / 1000)
    return None


def add_price(db: Session, item: Item, *, price: float, currency: str | None, unit: str | None, source: str,
              valid_from: date, user_id: int, doc: str | None = None, note: str | None = None) -> ItemPrice:
    """Новая цена позиции (без commit). Первая цена задаёт позиции её
    условную единицу (валюту), если та не была выбрана."""
    if price < 0:
        raise ValueError("Цена не может быть отрицательной")
    cur = (currency or default_currency(item)).upper()
    if db.get(Currency, cur) is None:
        raise ValueError(f"Неизвестная валюта: {cur}")
    if item.price_currency is None and cur != RUB:
        item.price_currency = cur
    p = ItemPrice(item_id=item.id, price=price, currency=cur, unit=unit or default_unit(item), source=source,
                  valid_from=valid_from, user_id=user_id, doc=(doc or None), note=(note or None))
    db.add(p)
    return p


# ---------- загрузка из 1С ----------

_CURRENCY_WORDS = {
    "руб": RUB, "rub": RUB, "₽": RUB, "р": RUB, "rur": RUB,
    "eur": "EUR", "евро": "EUR", "€": "EUR",
    "usd": "USD", "долл": "USD", "доллар": "USD", "$": "USD",
}


def parse_currency(text: str | None) -> str | None:
    t = (text or "").strip().lower().rstrip(".")
    if not t:
        return None
    if t.upper() in ("RUB", "EUR", "USD"):
        return t.upper()
    for k, v in _CURRENCY_WORDS.items():
        if t.startswith(k.rstrip(".")):
            return v
    return None


def parse_price(text: object) -> float | None:
    if isinstance(text, (int, float)):
        return float(text)
    t = re.sub(r"[^\d,.\-]", "", str(text or "")).replace(",", ".")
    if t.count(".") > 1:  # 1.234.56 → разделители тысяч
        head, _, tail = t.rpartition(".")
        t = head.replace(".", "") + "." + tail
    try:
        return float(t) if t else None
    except ValueError:
        return None


@dataclass
class ImportRow:
    line: int
    code: str | None
    name: str | None
    price: float | None
    currency: str | None
    item_id: int | None = None
    item_name: str | None = None
    matched_by: str | None = None  # «код 1С» / «название»
    old: str | None = None  # действующая цена — для сравнения
    errors: list[str] = field(default_factory=list)


def import_1c(db: Session, rows: list[dict], *, default_currency_code: str | None, valid_from: date, user_id: int,
              doc: str | None, dry_run: bool) -> list[ImportRow]:
    """Строки выгрузки 1С {code, name, price, currency} → цены позиций.
    Позиция ищется по коду 1С, потом по названию (без учёта регистра и ё).
    Валюта — из строки, иначе своя валюта позиции, иначе выбранная по
    умолчанию. dry_run — только сопоставление."""
    items = db.query(Item).filter(Item.is_model.is_(False)).all()
    by_code = {i.code_1c.strip(): i for i in items if i.code_1c}
    by_name: dict[str, Item] = {}
    for i in items:
        by_name.setdefault(normalize_name(i.name), i)
    out: list[ImportRow] = []
    for n, r in enumerate(rows, 1):
        code = (str(r.get("code") or "").strip()) or None
        name = (str(r.get("name") or "").strip()) or None
        row = ImportRow(line=n, code=code, name=name, price=parse_price(r.get("price")),
                        currency=parse_currency(r.get("currency")))
        item = by_code.get(code) if code else None
        if item is not None:
            row.matched_by = "код 1С"
        elif name and normalize_name(name) in by_name:
            item = by_name[normalize_name(name)]
            row.matched_by = "название"
        if item is None:
            row.errors.append("позиция не найдена")
        if row.price is None:
            row.errors.append("нет цены")
        if r.get("currency") and row.currency is None:
            row.errors.append(f"валюта «{r.get('currency')}» не распознана")
        if item is not None:
            row.item_id, row.item_name = item.id, item.name
            cur = current_price(db, item.id)
            if cur is not None:
                row.old = f"{float(cur.price):g} {cur.currency}/{cur.unit}"
            if not row.errors and not dry_run:
                add_price(db, item, price=row.price, currency=row.currency or item.price_currency or default_currency_code,
                          unit=None, source=PRICE_1C, valid_from=valid_from, user_id=user_id, doc=doc)
                if code and not item.code_1c:
                    item.code_1c = code  # сопоставили по названию — запомним код
        out.append(row)
    return out
