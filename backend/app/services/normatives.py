"""Нормативы запаса — один механизм для любого вида номенклатуры (этап 4
пересборки, 08.10.2026): плёнка, п/ф, материалы.

У позиции (Item) три числа в её единице (плёнка — м²):
  min_stock      — минимальный остаток: ниже него — пора пополнять;
  min_batch      — минимальная партия: меньше не заказывают/не запускают;
  batch_multiple — кратность: партия округляется вверх до кратного
                   (рулоны по 300 м², листы по 5…).

  нужно     = потребность (задания, заказы, резерв) + мин. остаток;
  есть      = остаток + уже едет/в работе (заявки, запущенное);
  не хватает = нужно − есть;
  пополнить = не хватает, не меньше мин. партии, вверх до кратного.

Откуда «потребность» и «есть» — у каждого вида своё (у плёнки резерв
заданий и открытые заявки, у п/ф задания цеха и партии, у материалов
остаток заказов), правило пополнения — одно, здесь."""

import math
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.items import Item, item_unit

FILM_UNIT = "м²"


@dataclass(frozen=True)
class Norms:
    min_stock: float | None = None
    min_batch: float | None = None
    batch_multiple: float | None = None

    @property
    def empty(self) -> bool:
        return self.min_stock is None and self.min_batch is None and self.batch_multiple is None


def _f(v) -> float | None:
    return None if v is None else float(v)


def norms_of(item: Item | None) -> Norms:
    if item is None:
        return Norms()
    return Norms(_f(item.min_stock), _f(item.min_batch), _f(item.batch_multiple))


def norms_unit(item: Item) -> str:
    return FILM_UNIT if item.kind.code == "plenka" else item_unit(item)


def round_batch(qty: float, norms: Norms) -> float:
    """Партия к заказу/запуску: не меньше мин. партии, вверх до кратного."""
    if qty <= 0:
        return 0.0
    q = max(qty, norms.min_batch or 0.0)
    m = norms.batch_multiple
    if m and m > 0:
        q = math.ceil(round(q / m, 9)) * m
    return round(q, 3)


def suggest(*, demand: float, have: float, norms: Norms) -> tuple[float, float, float]:
    """(нужно, не хватает, пополнить) — одна формула для всех видов."""
    need = demand + (norms.min_stock or 0.0)
    shortage = round(max(0.0, need - have), 3)
    return round(need, 3), shortage, round_batch(shortage, norms)


def merge(norms: list[Norms]) -> Norms:
    """Нормативы группы позиций (плёнка: материал + цвет + толщина у разных
    производителей — один пул остатка): берётся наибольшее заданное."""

    def mx(vals):
        vals = [v for v in vals if v is not None]
        return max(vals) if vals else None

    return Norms(mx(n.min_stock for n in norms), mx(n.min_batch for n in norms), mx(n.batch_multiple for n in norms))


def film_group_norms(db: Session) -> dict[tuple[int, int, int], Norms]:
    """Нормативы плёнки по группе материал + цвет + толщина (как считается
    остаток и резерв) — из позиций номенклатуры её производителей."""
    from app.models.dictionaries import MaterialSku

    by_group: dict[tuple[int, int, int], list[Norms]] = {}
    rows = (
        db.query(MaterialSku.material_id, MaterialSku.color_id, MaterialSku.thickness_id, Item)
        .join(Item, Item.id == MaterialSku.item_id)
        .filter((Item.min_stock.isnot(None)) | (Item.min_batch.isnot(None)) | (Item.batch_multiple.isnot(None)))
    )
    for m, c, t, item in rows:
        by_group.setdefault((m, c, t), []).append(norms_of(item))
    return {g: merge(ns) for g, ns in by_group.items()}
