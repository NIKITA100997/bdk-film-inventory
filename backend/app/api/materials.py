"""Материалы (вид «Материал»): остатки, приход, списание, инвентаризация,
журнал движений (services/materials.py)."""

from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.items import MOVE_KINDS, Item, ItemGroup, ItemKind, MaterialMove, item_unit
from app.models.production import ProductionTaskLine
from app.models.users import User
from app.services import materials

# /materials занят справочником материалов плёнки (ПВХ, ПЭТ…) — отсюда свой адрес.
router = APIRouter(prefix="/material-stock", tags=["material-stock"])

manage = require_permission("units.receive", "materials.manage", "production_tasks.manage", "part_units.manage")


class MaterialOut(BaseModel):
    item_id: int
    name: str
    unit: str
    group_id: int | None
    group_name: str | None
    is_active: bool
    balance: float
    last_move_at: datetime | None


def _kind(db: Session) -> ItemKind:
    kind = db.query(ItemKind).filter(ItemKind.code == materials.KIND_MATERIAL).first()
    if kind is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Нет вида номенклатуры «Материал»")
    return kind


def _get(db: Session, item_id: int) -> Item:
    item = db.get(Item, item_id)
    if item is None or item.kind.code != materials.KIND_MATERIAL:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Материал не найден")
    return item


def _out(db: Session, items: list[Item]) -> list[MaterialOut]:
    ids = [i.id for i in items]
    bal = materials.balances(db, ids)
    last = dict(
        db.query(MaterialMove.item_id, func.max(MaterialMove.occurred_at))
        .filter(MaterialMove.item_id.in_(ids))
        .group_by(MaterialMove.item_id)
    ) if ids else {}
    groups = {g.id: g.name for g in db.query(ItemGroup)}
    return [
        MaterialOut(
            item_id=i.id, name=i.name, unit=item_unit(i), group_id=i.group_id, group_name=groups.get(i.group_id),
            is_active=i.is_active, balance=round(bal[i.id], 4), last_move_at=last.get(i.id),
        )
        for i in items
    ]


@router.get("", response_model=list[MaterialOut])
def list_materials(
    include_inactive: bool = False, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> list[MaterialOut]:
    q = db.query(Item).filter(Item.kind_id == _kind(db).id, Item.is_model.is_(False))
    if not include_inactive:
        q = q.filter(Item.is_active.is_(True))
    return _out(db, q.order_by(Item.name).all())


class MaterialIn(BaseModel):
    name: str
    unit: str | None = None
    group_id: int | None = None


@router.post("", response_model=MaterialOut, status_code=status.HTTP_201_CREATED)
def create_material(payload: MaterialIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> MaterialOut:
    name = " ".join(payload.name.split())
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите название")
    kind = _kind(db)
    if db.query(Item.id).filter(Item.kind_id == kind.id, func.lower(Item.name) == name.lower()).first():
        raise HTTPException(status.HTTP_409_CONFLICT, f"Материал «{name}» уже есть")
    item = Item(kind_id=kind.id, name=name[:255], unit=(payload.unit or "").strip()[:16] or None, group_id=payload.group_id)
    db.add(item)
    db.commit()
    db.refresh(item)
    return _out(db, [item])[0]


class MaterialUpdate(BaseModel):
    name: str | None = None
    unit: str | None = None
    is_active: bool | None = None


@router.patch("/{item_id}", response_model=MaterialOut)
def update_material(
    item_id: int, payload: MaterialUpdate, db: Session = Depends(get_db), user: User = Depends(manage)
) -> MaterialOut:
    item = _get(db, item_id)
    if payload.name is not None:
        name = " ".join(payload.name.split())
        if not name:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите название")
        item.name = name[:255]
    if payload.unit is not None:
        item.unit = payload.unit.strip()[:16] or None
    if payload.is_active is not None:
        item.is_active = payload.is_active
    db.commit()
    db.refresh(item)
    return _out(db, [item])[0]


class MoveIn(BaseModel):
    item_id: int
    kind: str  # receipt | writeoff | adjust
    qty: float = Field(ge=0)
    doc: str | None = None
    note: str | None = None
    occurred_at: date | None = None
    # Цена прихода по УПД (05.10) — за единицу позиции, в валюте; попадает
    # в историю цен позиции.
    price: float | None = Field(default=None, ge=0)
    price_currency: str | None = None


class MoveOut(BaseModel):
    id: int
    item_id: int
    item_name: str
    unit: str
    kind: str
    qty: float
    doc: str | None
    note: str | None
    task_id: int | None
    user_name: str
    occurred_at: datetime


def _moves_out(db: Session, moves: list[MaterialMove]) -> list[MoveOut]:
    items = {i.id: i for i in db.query(Item).filter(Item.id.in_({m.item_id for m in moves}))} if moves else {}
    users = {u.id: (u.full_name or u.username) for u in db.query(User).filter(User.id.in_({m.user_id for m in moves}))} if moves else {}
    lines = (
        {ln.id: ln.task_id for ln in db.query(ProductionTaskLine).filter(ProductionTaskLine.id.in_({m.task_line_id for m in moves if m.task_line_id}))}
        if moves
        else {}
    )
    return [
        MoveOut(
            id=m.id, item_id=m.item_id, item_name=items[m.item_id].name, unit=item_unit(items[m.item_id]), kind=m.kind,
            qty=float(m.qty), doc=m.doc, note=m.note, task_id=lines.get(m.task_line_id), user_name=users.get(m.user_id, "—"),
            occurred_at=m.occurred_at,
        )
        for m in moves
    ]


@router.post("/moves", response_model=MoveOut, status_code=status.HTTP_201_CREATED)
def create_move(payload: MoveIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> MoveOut:
    """Приход (qty — сколько пришло), списание (qty — сколько, с причиной)
    или инвентаризация (qty — фактический остаток, пишется разница)."""
    if payload.kind not in MOVE_KINDS or payload.kind == "consumption":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Расход в производство пишется отчётом операции")
    item = _get(db, payload.item_id)
    when = datetime.combine(payload.occurred_at, time(12)) if payload.occurred_at else None
    try:
        move = materials.manual_move(
            db, item=item, kind=payload.kind, qty=payload.qty, user_id=user.id, doc=payload.doc, note=payload.note,
            occurred_at=when,
        )
    except ValueError as e:
        db.rollback()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    if payload.price is not None and payload.kind == "receipt":
        from app.models.prices import PRICE_UPD
        from app.services.prices import add_price

        try:
            add_price(db, item, price=payload.price, currency=payload.price_currency, unit=None, source=PRICE_UPD,
                      valid_from=payload.occurred_at or date.today(), user_id=user.id,
                      doc=f"УПД {payload.doc}" if payload.doc else None)
        except ValueError as e:
            db.rollback()
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    db.commit()
    db.refresh(move)
    return _moves_out(db, [move])[0]


@router.get("/moves", response_model=list[MoveOut])
def list_moves(
    item_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = Query(default=1000, le=5000),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MoveOut]:
    q = db.query(MaterialMove)
    if item_id is not None:
        q = q.filter(MaterialMove.item_id == item_id)
    if date_from is not None:
        q = q.filter(MaterialMove.occurred_at >= datetime.combine(date_from, time.min))
    if date_to is not None:
        q = q.filter(MaterialMove.occurred_at < datetime.combine(date_to + timedelta(days=1), time.min))
    return _moves_out(db, q.order_by(MaterialMove.occurred_at.desc(), MaterialMove.id.desc()).limit(limit).all())
