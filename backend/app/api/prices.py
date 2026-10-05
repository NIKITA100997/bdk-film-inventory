"""Цены и курсы валют (05.10): курсы, цена позиции вручную, история,
загрузка из 1С, сводный прайс."""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.items import Item, ItemKind
from app.models.prices import PRICE_MANUAL, PRICE_SOURCES, Currency, ItemPrice
from app.models.users import User
from app.services import prices as svc

router = APIRouter(tags=["prices"])
view_prices = require_permission("prices.view", "prices.manage")
manage_prices = require_permission("prices.manage")


class CurrencyOut(BaseModel):
    code: str
    name: str
    symbol: str
    rate: float | None
    updated_at: datetime | None


class CurrencyRateIn(BaseModel):
    rate: float | None


def _cur_out(c: Currency) -> CurrencyOut:
    return CurrencyOut(code=c.code, name=c.name, symbol=c.symbol, rate=float(c.rate) if c.rate is not None else None,
                       updated_at=c.updated_at)


@router.get("/currencies", response_model=list[CurrencyOut])
def list_currencies(db: Session = Depends(get_db), user: User = Depends(view_prices)) -> list[CurrencyOut]:
    order = {"RUB": 0, "EUR": 1, "USD": 2}
    return [_cur_out(c) for c in sorted(db.query(Currency), key=lambda c: (order.get(c.code, 9), c.code))]


@router.put("/currencies/{code}", response_model=CurrencyOut)
def set_rate(code: str, payload: CurrencyRateIn, db: Session = Depends(get_db), user: User = Depends(manage_prices)) -> CurrencyOut:
    c = db.get(Currency, code.upper())
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Валюта не найдена")
    if c.code == svc.RUB:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Курс рубля — всегда 1")
    if payload.rate is not None and payload.rate <= 0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Курс — больше нуля")
    c.rate = payload.rate
    c.updated_at = datetime.now(timezone.utc)
    c.updated_by = user.id
    db.commit()
    return _cur_out(c)


class PriceOut(BaseModel):
    id: int
    price: float
    currency: str
    unit: str
    rub: float | None
    source: str
    source_name: str
    doc: str | None
    valid_from: date
    note: str | None
    user_id: int
    created_at: datetime


class ItemPricesOut(BaseModel):
    item_id: int
    currency: str  # условная единица цены позиции
    unit: str
    current: PriceOut | None
    history: list[PriceOut]


def _price_out(p: ItemPrice, rate_map: dict) -> PriceOut:
    r = rate_map.get(p.currency)
    return PriceOut(
        id=p.id, price=float(p.price), currency=p.currency, unit=p.unit,
        rub=round(float(p.price) * r, 4) if r is not None else None,
        source=p.source, source_name=PRICE_SOURCES.get(p.source, p.source), doc=p.doc, valid_from=p.valid_from,
        note=p.note, user_id=p.user_id, created_at=p.created_at,
    )


def _get_item(db: Session, item_id: int) -> Item:
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    return item


@router.get("/items/{item_id}/prices", response_model=ItemPricesOut)
def item_prices(item_id: int, db: Session = Depends(get_db), user: User = Depends(view_prices)) -> ItemPricesOut:
    item = _get_item(db, item_id)
    rate_map = svc.rates(db)
    hist = (
        db.query(ItemPrice).filter(ItemPrice.item_id == item.id)
        .order_by(ItemPrice.valid_from.desc(), ItemPrice.id.desc()).limit(100).all()
    )
    cur = svc.current_price(db, item.id, date.today())
    return ItemPricesOut(
        item_id=item.id, currency=svc.default_currency(item), unit=svc.default_unit(item),
        current=_price_out(cur, rate_map) if cur else None, history=[_price_out(p, rate_map) for p in hist],
    )


class PriceIn(BaseModel):
    price: float
    currency: str | None = None
    unit: str | None = None
    valid_from: date | None = None
    doc: str | None = None
    note: str | None = None


@router.post("/items/{item_id}/prices", response_model=ItemPricesOut)
def add_item_price(item_id: int, payload: PriceIn, db: Session = Depends(get_db), user: User = Depends(manage_prices)) -> ItemPricesOut:
    item = _get_item(db, item_id)
    try:
        svc.add_price(db, item, price=payload.price, currency=payload.currency, unit=payload.unit, source=PRICE_MANUAL,
                      valid_from=payload.valid_from or date.today(), user_id=user.id, doc=payload.doc, note=payload.note)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    return item_prices(item_id, db, user)


@router.delete("/item-prices/{price_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item_price(price_id: int, db: Session = Depends(get_db), user: User = Depends(manage_prices)) -> None:
    p = db.get(ItemPrice, price_id)
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Цена не найдена")
    db.delete(p)
    db.commit()


class PriceSettingsIn(BaseModel):
    currency: str | None = None  # "" — рубли
    unit: str | None = None  # "" — единица позиции


@router.put("/items/{item_id}/price-settings", response_model=ItemPricesOut)
def set_price_settings(item_id: int, payload: PriceSettingsIn, db: Session = Depends(get_db), user: User = Depends(manage_prices)) -> ItemPricesOut:
    item = _get_item(db, item_id)
    if payload.currency is not None:
        cur = payload.currency.upper().strip()
        if cur and db.get(Currency, cur) is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Неизвестная валюта")
        item.price_currency = cur if cur and cur != svc.RUB else None
    if payload.unit is not None:
        item.price_unit = payload.unit.strip()[:16] or None
    db.commit()
    return item_prices(item_id, db, user)


class Import1CIn(BaseModel):
    rows: list[dict]  # {code, name, price, currency}
    default_currency: str | None = None
    valid_from: date | None = None
    doc: str | None = None
    dry_run: bool = True


class Import1COut(BaseModel):
    line: int
    code: str | None
    name: str | None
    price: float | None
    currency: str | None
    item_id: int | None
    item_name: str | None
    matched_by: str | None
    old: str | None
    errors: list[str]


@router.post("/prices/import-1c", response_model=list[Import1COut])
def import_prices_1c(payload: Import1CIn, db: Session = Depends(get_db), user: User = Depends(manage_prices)) -> list[Import1COut]:
    """Цены из выгрузки 1С (строки уже разобраны на экране по выбранным
    колонкам). dry_run — только сопоставление; иначе записываются строки
    без ошибок."""
    if len(payload.rows) > 20000:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Слишком много строк — не больше 20 000 за раз")
    rows = svc.import_1c(
        db, payload.rows, default_currency_code=(payload.default_currency or svc.RUB).upper(),
        valid_from=payload.valid_from or date.today(), user_id=user.id, doc=payload.doc, dry_run=payload.dry_run,
    )
    if payload.dry_run:
        db.rollback()
    else:
        db.commit()
    return [Import1COut(**r.__dict__) for r in rows]


class PriceListRow(BaseModel):
    item_id: int
    name: str
    kind: str
    code_1c: str | None
    currency: str
    unit: str
    price: float | None
    price_currency: str | None
    price_unit: str | None
    rub: float | None
    source: str | None
    valid_from: date | None


@router.get("/prices", response_model=list[PriceListRow])
def price_list(kind: str | None = None, db: Session = Depends(get_db), user: User = Depends(view_prices)) -> list[PriceListRow]:
    """Прайс: позиции с действующей ценой (плёнка и материалы по умолчанию)."""
    rate_map = svc.rates(db)
    kinds = {k.id: k for k in db.query(ItemKind)}
    q = db.query(Item).filter(Item.is_active.is_(True), Item.is_model.is_(False))
    codes = [kind] if kind else ["plenka", "material"]
    q = q.filter(Item.kind_id.in_([k.id for k in kinds.values() if k.code in codes]))
    latest: dict[int, ItemPrice] = {}
    for p in db.query(ItemPrice).filter(ItemPrice.valid_from <= date.today()).order_by(ItemPrice.valid_from, ItemPrice.id):
        latest[p.item_id] = p
    out = []
    for item in q.order_by(Item.name):
        p = latest.get(item.id)
        r = rate_map.get(p.currency) if p else None
        out.append(PriceListRow(
            item_id=item.id, name=item.name, kind=kinds[item.kind_id].name, code_1c=item.code_1c,
            currency=svc.default_currency(item), unit=svc.default_unit(item),
            price=float(p.price) if p else None, price_currency=p.currency if p else None, price_unit=p.unit if p else None,
            rub=round(float(p.price) * r, 2) if p and r is not None else None,
            source=PRICE_SOURCES.get(p.source) if p else None, valid_from=p.valid_from if p else None,
        ))
    return out
