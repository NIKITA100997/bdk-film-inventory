"""Снабжение участков (15.10, этап 3): заявки и неснижаемый остаток —
одна логика для плёнки, п/ф и материалов (models/area_supply.py).

Позиция — запись номенклатуры (Item). У плёнки остаток пулом по группе
материал + цвет + толщина (как везде в программе), поэтому норма и заявка
на любую позицию группы относятся ко всей группе."""

from collections import defaultdict
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.dictionaries import Color, Material, MaterialSku, Part, Thickness
from app.models.items import Item, ItemKind, item_unit
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.units import MaterialUnit, UnitStatus

FILM, PF, MATERIAL = "plenka", "pf", "material"


@dataclass
class ItemInfo:
    item_id: int
    kind: str
    label: str
    unit: str
    group: tuple[int, int, int] | None = None  # плёнка
    part_id: int | None = None  # п/ф


def _film_label(db: Session, m: int, c: int, t: int) -> str:
    return f"{db.get(Material, m).name} {db.get(Color, c).name} {float(db.get(Thickness, t).value_mm):g} мм"


def item_info(db: Session, item_id: int) -> ItemInfo | None:
    item = db.get(Item, item_id)
    if item is None:
        return None
    kind = db.get(ItemKind, item.kind_id).code
    if kind == FILM:
        sku = db.query(MaterialSku).filter(MaterialSku.item_id == item_id).first()
        if sku is None:
            return None
        g = (sku.material_id, sku.color_id, sku.thickness_id)
        return ItemInfo(item_id, kind, _film_label(db, *g), "м²", group=g)
    if kind == PF:
        part = db.query(Part).filter(Part.item_id == item_id).first()
        return ItemInfo(item_id, kind, part.name if part else item.name, "шт", part_id=part.id if part else None)
    return ItemInfo(item_id, kind, item.name, item_unit(item))


def catalog(db: Session, kind: str | None, q: str | None, limit: int = 30) -> list[ItemInfo]:
    """Подбор позиции для заявки/нормы: плёнка — по группам, п/ф — детали,
    материалы — позиции вида «Материал»."""
    words = [w for w in (q or "").lower().replace("ё", "е").split() if w]

    def hit(label: str) -> bool:
        s = label.lower().replace("ё", "е")
        return all(w in s for w in words)

    out: list[ItemInfo] = []
    if kind in (None, FILM):
        seen: set[tuple] = set()
        rows = (
            db.query(MaterialSku.material_id, MaterialSku.color_id, MaterialSku.thickness_id, MaterialSku.item_id)
            .filter(MaterialSku.item_id.isnot(None), MaterialSku.is_active.is_(True))
            .order_by(MaterialSku.id)
        )
        for m, c, t, iid in rows:
            if (m, c, t) in seen:
                continue
            seen.add((m, c, t))
            label = _film_label(db, m, c, t)
            if hit(label):
                out.append(ItemInfo(iid, FILM, label, "м²", group=(m, c, t)))
    if kind in (None, PF):
        for p in db.query(Part).filter(Part.item_id.isnot(None), Part.is_active.is_(True)).order_by(Part.name):
            if hit(p.name):
                out.append(ItemInfo(p.item_id, PF, p.name, "шт", part_id=p.id))
    if kind in (None, MATERIAL):
        mk = db.query(ItemKind).filter(ItemKind.code == MATERIAL).first()
        if mk is not None:
            for it in db.query(Item).filter(Item.kind_id == mk.id, Item.is_active.is_(True), Item.is_model.is_(False)).order_by(Item.name):
                if hit(it.name):
                    out.append(ItemInfo(it.id, MATERIAL, it.name, item_unit(it)))
    out.sort(key=lambda i: i.label.lower())
    return out[:limit]


def area_film_stock(db: Session) -> dict[tuple[str, tuple[int, int, int]], float]:
    """м² плёнки на участках по группе — остаток выданных рулонов/штрипсов."""
    from app.api.production import _issued_unit_remaining_m

    out: dict[tuple[str, tuple[int, int, int]], float] = defaultdict(float)
    for u in db.query(MaterialUnit).filter(MaterialUnit.status == UnitStatus.VYDAN_UCHASTKU, MaterialUnit.area.isnot(None)):
        sku = u.material_sku
        out[(u.area, (sku.material_id, sku.color_id, sku.thickness_id))] += _issued_unit_remaining_m(db, u) * float(u.width_mm) / 1000
    return out


def area_pf_stock(db: Session) -> dict[tuple[str, int], float]:
    """шт п/ф на участках (годные партии, не в переработке)."""
    out: dict[tuple[str, int], float] = defaultdict(float)
    q = db.query(PartUnit.area, PartUnit.part_id, PartUnit.quantity_pieces).filter(
        PartUnit.area.isnot(None), PartUnit.status.in_([PartUnitStatus.NA_KHRANENII, PartUnitStatus.VYDAN_UCHASTKU])
    )
    for area, part_id, qty in q:
        out[(area, part_id)] += float(qty)
    return out


def measurable(info: ItemInfo) -> bool:
    """Остаток на участке ведётся только у плёнки и п/ф."""
    return info.kind == FILM or (info.kind == PF and info.part_id is not None)


def on_film_issued(db: Session, unit: MaterialUnit, length_m: float, user_id: int) -> None:
    """Рулон/штрипс выдан участку — засчитать в открытые заявки этого участка
    на ту же плёнку (сначала старшие). Заявка без количества или набравшая
    своё — «выдано» с номером рулона; иначе копится выданное."""
    from datetime import datetime, timezone

    from app.models.area_supply import REQ_DONE, REQ_OPEN, AreaRequest

    sku = unit.material_sku
    group = (sku.material_id, sku.color_id, sku.thickness_id)
    m2 = float(unit.width_mm) * length_m / 1000
    reqs = (
        db.query(AreaRequest)
        .filter(AreaRequest.area == unit.area, AreaRequest.status.in_(REQ_OPEN), AreaRequest.item_id.isnot(None))
        .order_by(AreaRequest.needed_by.asc().nulls_last(), AreaRequest.id)
        .all()
    )
    for r in reqs:
        info = item_info(db, r.item_id)
        if info is None or info.group != group or m2 <= 0.001:
            continue
        need = float(r.qty) - float(r.issued_qty or 0) if r.qty is not None else m2
        take = min(m2, need) if r.qty is not None else m2
        r.issued_qty = round(float(r.issued_qty or 0) + take, 3)
        m2 -= take
        tag = f"№{unit.id} {float(unit.width_mm):g} мм × {length_m:g} м"
        r.close_note = ((r.close_note + "; ") if r.close_note else "выдано: ") + tag
        r.close_note = r.close_note[:255]
        if r.qty is None or float(r.issued_qty) >= float(r.qty) - 0.01:
            r.status, r.closed_by, r.closed_at = REQ_DONE, user_id, datetime.now(timezone.utc)
        if r.qty is None:
            break  # без количества — одна заявка на выдачу


def film_stock_m2(db: Session) -> dict[tuple[int, int, int], float]:
    """м² плёнки на складах (рулоны и штрипсы на хранении) по группе."""
    out: dict[tuple[int, int, int], float] = defaultdict(float)
    q = (
        db.query(MaterialSku.material_id, MaterialSku.color_id, MaterialSku.thickness_id, MaterialUnit.width_mm, MaterialUnit.length_m)
        .join(MaterialUnit, MaterialUnit.material_sku_id == MaterialSku.id)
        .filter(MaterialUnit.status == UnitStatus.NA_KHRANENII)
    )
    for m, c, t, w, l in q:
        out[(m, c, t)] += float(w) * float(l) / 1000
    return out
