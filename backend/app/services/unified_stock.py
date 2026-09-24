"""Единые остатки и единый журнал движений (этап 5 единой модели, слои 1–2).

Только чтение: два учёта (рулоны/штрипсы плёнки — MaterialUnit, партии п/ф —
PartUnit) сводятся в одни строки «партия позиции»: позиция номенклатуры,
количество в своей единице (м у плёнки, шт у п/ф), статус, участок/место,
для п/ф — этап. Журнал — события обоих учётов одной лентой. Логика самих
учётов не меняется."""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.models.dictionaries import MaterialSku, Part, PartStage
from app.models.events import MaterialEvent
from app.models.items import sku_item_name
from app.models.part_units import PartUnit, PartUnitEvent, PartUnitStatus
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


@dataclass
class MovementRow:
    kind: str
    at: datetime
    event: str
    lot_id: int
    item_id: int | None
    item_name: str
    qty_delta: float | None
    unit: str
    area: str | None
    from_place: str | None
    to_place: str | None
    user_id: int | None
    note: str | None


def list_movements(
    db: Session,
    *,
    kind: str | None = None,
    item_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = 500,
) -> list[MovementRow]:
    out: list[MovementRow] = []
    if kind in (None, KIND_FILM):
        q = db.query(MaterialEvent, MaterialSku).join(MaterialSku, MaterialSku.id == MaterialEvent.material_sku_id).options(
            joinedload(MaterialSku.material), joinedload(MaterialSku.color),
            joinedload(MaterialSku.thickness), joinedload(MaterialSku.manufacturer),
        )
        if item_id is not None:
            q = q.filter(MaterialSku.item_id == item_id)
        if date_from:
            q = q.filter(MaterialEvent.timestamp >= datetime.combine(date_from, datetime.min.time()))
        if date_to:
            q = q.filter(MaterialEvent.timestamp < datetime.combine(date_to, datetime.max.time()))
        for e, sku in q.order_by(MaterialEvent.timestamp.desc()).limit(limit):
            out.append(
                MovementRow(
                    kind=KIND_FILM, at=e.timestamp, event=_label(e.event_type.value), lot_id=e.unit_id, item_id=sku.item_id,
                    item_name=sku_item_name(sku.material.name, sku.color.name, sku.thickness.value_mm, sku.manufacturer.name),
                    qty_delta=float(e.quantity_delta_m) if e.quantity_delta_m is not None else None, unit="м",
                    area=e.area, from_place=e.from_cell, to_place=e.to_cell, user_id=e.user_id,
                    note=e.write_off_note,
                )
            )
    if kind in (None, KIND_PF):
        stages = {s.id: s.name for s in db.query(PartStage)}
        q = db.query(PartUnitEvent, PartUnit, Part).join(PartUnit, PartUnit.id == PartUnitEvent.part_unit_id).join(
            Part, Part.id == PartUnit.part_id
        )
        if item_id is not None:
            q = q.filter(Part.item_id == item_id)
        if date_from:
            q = q.filter(PartUnitEvent.occurred_at >= datetime.combine(date_from, datetime.min.time()))
        if date_to:
            q = q.filter(PartUnitEvent.occurred_at < datetime.combine(date_to, datetime.max.time()))
        for e, u, p in q.order_by(PartUnitEvent.occurred_at.desc()).limit(limit):
            from_place = e.from_cell or (stages.get(e.from_stage_id) if e.from_stage_id else None)
            to_place = e.to_cell or (stages.get(e.to_stage_id) if e.to_stage_id else None)
            out.append(
                MovementRow(
                    kind=KIND_PF, at=e.occurred_at, event=_label(e.event_type.value), lot_id=u.id, item_id=p.item_id,
                    item_name=p.name, qty_delta=float(e.quantity_delta) if e.quantity_delta is not None else None,
                    unit="шт", area=e.area, from_place=from_place, to_place=to_place, user_id=e.user_id,
                    note=e.note or e.write_off_note,
                )
            )
    out.sort(key=lambda r: r.at, reverse=True)
    return out[:limit]


def totals_by_item(rows: list[LotRow]) -> dict[int | None, dict]:
    agg: dict[int | None, dict] = defaultdict(lambda: {"qty": 0.0, "lots": 0, "area_m2": 0.0})
    for r in rows:
        a = agg[r.item_id]
        a["qty"] += r.qty
        a["lots"] += 1
        a["area_m2"] += r.area_m2 or 0.0
    return agg
