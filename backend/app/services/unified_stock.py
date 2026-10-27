"""Единые остатки и единый журнал движений (этап 5 единой модели, слои 1–2).

Только чтение: два учёта (рулоны/штрипсы плёнки — MaterialUnit, партии п/ф —
PartUnit) сводятся в одни строки «партия позиции»: позиция номенклатуры,
количество в своей единице (м у плёнки, шт у п/ф), статус, участок/место,
для п/ф — этап. Журнал — события обоих учётов одной лентой. Логика самих
учётов не меняется."""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.models.dictionaries import MaterialSku, Part
from app.models.items import sku_item_name
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.production import ProductionTaskLine, ProductionTaskLineReport
from app.models.units import MaterialUnit, UnitStatus
from app.services.part_units import reported_good_pieces_by_unit

KIND_FILM = "plenka"
KIND_PF = "pf"


def _label(value: str) -> str:
    return value.replace("_", " ")


@dataclass
class LotRow:
    kind: str  # plenka / pf
    lot_id: int
    item_id: int | None
    item_name: str
    qty: float  # свободное количество в своей единице
    unit: str  # «м» / «шт»
    status: str
    area: str | None
    location_code: str | None
    stage: str | None  # у п/ф — этап маршрута
    detail: str | None  # у плёнки — «рулон 1250 мм», «штрипс 292 мм»
    area_m2: float | None
    since: date | None  # дата изготовления / приёмки
    sku_id: int | None = None
    part_id: int | None = None


def _film_consumed(db: Session, unit_ids: list[int]) -> dict[int, float]:
    """Сколько метров выданных рулонов уже израсходовано по отчётам —
    та же арифметика, что «остаток рулона» в заданиях цеха."""
    if not unit_ids:
        return {}
    rows = (
        db.query(
            ProductionTaskLineReport.material_unit_id,
            func.sum((ProductionTaskLineReport.good_pieces + ProductionTaskLineReport.defect_pieces) * ProductionTaskLine.length_m),
        )
        .join(ProductionTaskLine, ProductionTaskLine.id == ProductionTaskLineReport.task_line_id)
        .filter(ProductionTaskLineReport.material_unit_id.in_(unit_ids))
        .group_by(ProductionTaskLineReport.material_unit_id)
        .all()
    )
    return {uid: float(v or 0) for uid, v in rows}


def list_lots(
    db: Session,
    *,
    kind: str | None = None,
    item_id: int | None = None,
    area: str | None = None,
    include_written_off: bool = False,
) -> list[LotRow]:
    out: list[LotRow] = []
    if kind in (None, KIND_FILM):
        q = db.query(MaterialUnit).options(
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.material),
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.color),
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.thickness),
            joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.manufacturer),
        )
        if not include_written_off:
            q = q.filter(MaterialUnit.status != UnitStatus.SPISAN)
        if area:
            q = q.filter(MaterialUnit.area == area)
        if item_id is not None:
            q = q.join(MaterialSku, MaterialSku.id == MaterialUnit.material_sku_id).filter(MaterialSku.item_id == item_id)
        units = q.all()
        consumed = _film_consumed(db, [u.id for u in units if u.status == UnitStatus.VYDAN_UCHASTKU])
        for u in units:
            sku = u.material_sku
            length = max(0.0, float(u.length_m) - consumed.get(u.id, 0.0))
            width = float(u.width_mm)
            out.append(
                LotRow(
                    kind=KIND_FILM, lot_id=u.id, item_id=sku.item_id,
                    item_name=sku_item_name(sku.material.name, sku.color.name, sku.thickness.value_mm, sku.manufacturer.name),
                    qty=round(length, 2), unit="м", status=_label(u.status.value), area=u.area,
                    location_code=u.location_code, stage=None,
                    detail=f"{'штрипс' if u.is_strip else 'рулон'} {width:g} мм",
                    area_m2=round(width / 1000 * length, 2),
                    since=u.created_at.date() if u.created_at else None, sku_id=sku.id,
                )
            )
    if kind in (None, KIND_PF):
        q = db.query(PartUnit).options(joinedload(PartUnit.part), joinedload(PartUnit.stage))
        if not include_written_off:
            q = q.filter(PartUnit.status != PartUnitStatus.SPISAN)
        if area:
            q = q.filter(PartUnit.area == area)
        if item_id is not None:
            q = q.join(Part, Part.id == PartUnit.part_id).filter(Part.item_id == item_id)
        units = q.all()
        reported = reported_good_pieces_by_unit(db, [u.id for u in units])
        for u in units:
            free = max(0.0, float(u.quantity_pieces) - reported.get(u.id, 0.0))
            if free <= 0 and u.status != PartUnitStatus.SPISAN and not include_written_off:
                continue  # партия полностью отчитана — физически её уже нет
            out.append(
                LotRow(
                    kind=KIND_PF, lot_id=u.id, item_id=u.part.item_id, item_name=u.part.name, qty=round(free, 2),
                    unit="шт", status=_label(u.status.value), area=u.area, location_code=u.location_code,
                    stage=u.stage.name if u.stage else None, detail=None, area_m2=None,
                    since=u.manufactured_at, part_id=u.part_id,
                )
            )
    return out


def totals_by_item(rows: list[LotRow]) -> dict[int | None, dict]:
    agg: dict[int | None, dict] = defaultdict(lambda: {"qty": 0.0, "lots": 0, "area_m2": 0.0})
    for r in rows:
        a = agg[r.item_id]
        a["qty"] += r.qty
        a["lots"] += 1
        a["area_m2"] += r.area_m2 or 0.0
    return agg


@dataclass
class ItemStock:
    item_id: int
    kind: str  # plenka / pf / material / fg
    qty: float  # остаток в своей единице (м / шт / ед. материала)
    unit: str
    reserved: float  # из остатка закреплено за заданиями / заказами
    lots: int  # рулонов и штрипсов / партий (у материалов и изделий — 0)
    area_m2: float | None  # у плёнки
    places: list[str]  # склады / участки / площадки


def stock_by_item(db: Session, *, with_pf: bool = True) -> list[ItemStock]:
    """Остаток по позиции номенклатуры (27.10, «Номенклатура = остатки»):
    все четыре учёта одной строкой на позицию — плёнка (м, по рулонам),
    п/ф (шт, по партиям), материалы и готовые изделия (одним числом)."""
    from app.models.areas import Area
    from app.models.film_reserve import RES_ACTIVE, FilmReservation
    from app.models.items import Item, item_unit
    from app.models.sites import Site
    from app.services import finished_goods, materials
    from app.services.pf_demand import reserves_by_part
    from app.services.warehouses import rack_warehouse_names, resolve_warehouse_name

    areas = {a.code: a.name for a in db.query(Area)}
    wh = rack_warehouse_names(db)
    acc: dict[int, ItemStock] = {}
    places: dict[int, set[str]] = defaultdict(set)

    def row(item_id: int, kind: str, unit: str) -> ItemStock:
        if item_id not in acc:
            acc[item_id] = ItemStock(item_id, kind, 0.0, unit, 0.0, 0, None, [])
        return acc[item_id]

    film = [r for r in list_lots(db, kind=KIND_FILM) if r.item_id is not None and r.qty > 0]
    res_m = dict(
        db.query(FilmReservation.unit_id, func.sum(FilmReservation.length_m))
        .filter(FilmReservation.status == RES_ACTIVE)
        .group_by(FilmReservation.unit_id)
    )
    for r in film:
        s = row(r.item_id, KIND_FILM, "м")
        s.qty += r.qty
        s.lots += 1
        s.area_m2 = (s.area_m2 or 0.0) + (r.area_m2 or 0.0)
        s.reserved += min(r.qty, float(res_m.get(r.lot_id) or 0))
        places[r.item_id].add(areas.get(r.area) if r.area else resolve_warehouse_name(wh, r.location_code) or "без места")

    if with_pf:
        part_item: dict[int, int] = {}
        for r in list_lots(db, kind=KIND_PF):
            if r.item_id is None or r.qty <= 0 or r.status == "В переработку":
                continue
            part_item[r.part_id] = r.item_id
            s = row(r.item_id, KIND_PF, "шт")
            s.qty += r.qty
            s.lots += 1
            places[r.item_id].add(areas.get(r.area) if r.area else "склад п/ф")
        for pr in reserves_by_part(db):
            if pr.part_id in part_item:
                acc[part_item[pr.part_id]].reserved += pr.reserved

    mat = {i: q for i, q in materials.balances(db).items() if q > 1e-9}
    fg = [b for b in finished_goods.balances(db) if b.qty > 0]
    items = {i.id: i for i in db.query(Item).filter(Item.id.in_(set(mat) | {b.item_id for b in fg}))} if mat or fg else {}
    for item_id, q in mat.items():
        it = items.get(item_id)
        s = row(item_id, "material", item_unit(it) if it else "")
        s.qty += q
        places[item_id].add("склад материалов")
    sites = {x.id: x.name for x in db.query(Site)}
    for b in fg:
        s = row(b.item_id, "fg", "шт")
        s.qty += b.qty
        places[b.item_id].add(sites.get(b.site_id) or "склад ГП")

    for item_id, s in acc.items():
        s.qty = round(s.qty, 2)
        s.reserved = round(min(s.reserved, s.qty), 2)
        s.area_m2 = round(s.area_m2, 2) if s.area_m2 is not None else None
        s.places = sorted(places[item_id])
    return list(acc.values())
