"""Инвентаризация по месту (27.10; до того — пересчёт п/ф на участке, 06.10).
Модель и смысл — models/part_counts.py, логика — services/stock_counts.py
(п/ф — services/part_counts.py). Право — по виду: что в месте можно
считать, решают права на виды (services/stock_counts.PLACE_KINDS)."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, joinedload

from app.core.security import get_permission_codes, require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.dictionaries import MaterialSku, Part, PartStage
from app.models.items import Item, ItemGroup, item_unit, sku_item_name
from app.models.part_counts import (
    COUNT_CLOSED,
    COUNT_IN_PROGRESS,
    KIND_FG,
    KIND_FILM,
    KIND_MATERIAL,
    KIND_PF,
    PLACE_AREA,
    PLACE_FG,
    PLACE_MATERIALS,
    PLACE_WAREHOUSE,
    PartCountLine,
    PartCountSession,
)
from app.models.sites import Site
from app.models.storage import Warehouse
from app.models.units import MaterialUnit
from app.models.users import User
from app.services import part_counts as pf
from app.services import stock_counts as svc

router = APIRouter(prefix="/part-counts", tags=["part-counts"])

# допуск к инвентаризации — любое право на пересчёт какого-нибудь вида; что
# именно в месте можно считать — по видам (_kinds)
count_any = require_permission(*sorted({c for kinds in svc.PLACE_KINDS.values() for _, codes in kinds for c in codes}))

PLACE_LABEL = {PLACE_AREA: "Участок", PLACE_WAREHOUSE: "Склад плёнки", PLACE_MATERIALS: "Склад материалов", PLACE_FG: "Склад ГП"}


def _kinds(user: User, place_type: str) -> list[str]:
    return svc.kinds_for(place_type, get_permission_codes(user), user.is_superuser)


def _require(user: User, s: PartCountSession) -> None:
    if not _kinds(user, s.place_type):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Нет прав на инвентаризацию этого места")


class ScopeIn(BaseModel):
    group_ids: list[int] = []
    # стадии позиции: blank / bare / laminated / stripped
    stages: list[str] = []


class SessionCreate(BaseModel):
    place_type: str = PLACE_AREA
    place_ref: str | None = None
    area: str | None = None  # прежний вызов — участок
    scope: ScopeIn = ScopeIn()
    note: str | None = Field(default=None, max_length=255)


class LineOut(BaseModel):
    id: int
    kind: str
    name: str
    unit: str
    detail: str | None  # этап п/ф / «рулон 1250 мм» / площадка
    lot: str | None  # номер партии / рулона
    part_unit_id: int | None
    material_unit_id: int | None
    part_id: int | None
    item_id: int | None
    group_name: str | None
    stage_id: int | None
    stage_name: str | None
    manufactured_at: str | None
    location_code: str | None
    elsewhere: str | None  # плёнка, найденная тут, а по учёту — в другом месте
    expected_qty: float
    counted_qty: float | None
    diff: float | None
    decision: str | None
    allowed: list[str]
    reason: str | None
    note: str | None
    result_part_unit_id: int | None


class SessionOut(BaseModel):
    id: int
    place_type: str
    place_ref: str | None
    place_name: str
    area: str | None
    area_name: str
    kinds: list[str]
    scope: dict | None
    status: str
    note: str | None
    started_by: int
    started_at: datetime
    closed_at: datetime | None
    lines_total: int
    lines_counted: int
    lines_diff: int
    lines_open: int  # расхождения без решения (после закрытия)


class SessionDetail(SessionOut):
    lines: list[LineOut]


def _session(db: Session, session_id: int, user: User) -> PartCountSession:
    s = db.get(PartCountSession, session_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пересчёт не найден")
    _require(user, s)
    return s


def _line(db: Session, s: PartCountSession, line_id: int) -> PartCountLine:
    line = db.get(PartCountLine, line_id)
    if line is None or line.session_id != s.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Строка не найдена")
    return line


def _place_name(db: Session, s: PartCountSession) -> str:
    if s.place_type == PLACE_AREA:
        a = db.get(Area, s.area) if s.area else None
        return a.name if a else (s.area or "—")
    if s.place_type == PLACE_WAREHOUSE:
        w = db.get(Warehouse, int(s.place_ref)) if s.place_ref else None
        return w.name if w else "склад"
    if s.place_type == PLACE_FG:
        site = db.get(Site, int(s.place_ref)) if s.place_ref else None
        return f"Склад ГП · {site.name}" if site else "Склад ГП"
    return "Склад материалов"


def _summary(db: Session, s: PartCountSession, lines: list[PartCountLine], user: User) -> dict:
    diffs = [ln for ln in lines if pf.diff_of(float(ln.expected_qty), None if ln.counted_qty is None else float(ln.counted_qty))]
    name = _place_name(db, s)
    return dict(
        id=s.id, place_type=s.place_type, place_ref=s.place_ref, place_name=name, area=s.area, area_name=name,
        # что в месте считается этим пользователем + что уже есть в листе
        kinds=sorted({ln.kind for ln in lines} | set(_kinds(user, s.place_type))), scope=s.scope, status=s.status, note=s.note,
        started_by=s.started_by, started_at=s.started_at, closed_at=s.closed_at, lines_total=len(lines),
        lines_counted=sum(1 for ln in lines if ln.counted_qty is not None), lines_diff=len(diffs),
        lines_open=sum(1 for ln in diffs if ln.decision is None),
    )


def _lines_out(db: Session, s: PartCountSession, lines: list[PartCountLine]) -> list[LineOut]:
    from app.models.part_units import PartUnit
    from app.services.warehouses import rack_warehouse_names, resolve_warehouse_name

    part_ids = {ln.part_id for ln in lines if ln.part_id}
    parts = {p.id: p for p in db.query(Part).filter(Part.id.in_(part_ids))} if part_ids else {}
    stage_ids = {ln.stage_id for ln in lines if ln.stage_id}
    stages = {st.id: st for st in db.query(PartStage).filter(PartStage.id.in_(stage_ids))} if stage_ids else {}
    pu_ids = {ln.part_unit_id for ln in lines if ln.part_unit_id}
    punits = {u.id: u for u in db.query(PartUnit).filter(PartUnit.id.in_(pu_ids))} if pu_ids else {}
    mu_ids = {ln.material_unit_id for ln in lines if ln.material_unit_id}
    munits = (
        {
            u.id: u
            for u in db.query(MaterialUnit)
            .options(
                joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.material),
                joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.color),
                joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.thickness),
                joinedload(MaterialUnit.material_sku).joinedload(MaterialSku.manufacturer),
            )
            .filter(MaterialUnit.id.in_(mu_ids))
        }
        if mu_ids
        else {}
    )
    item_ids = {p.item_id for p in parts.values() if p.item_id} | {ln.item_id for ln in lines if ln.item_id}
    items = {i.id: i for i in db.query(Item).filter(Item.id.in_(item_ids))} if item_ids else {}
    groups = {g.id: g.name for g in db.query(ItemGroup)}
    sites = {x.id: x.name for x in db.query(Site)}
    areas = {a.code: a.name for a in db.query(Area)}
    wh = rack_warehouse_names(db) if munits else {}
    out = []
    for ln in lines:
        exp = float(ln.expected_qty)
        cnt = None if ln.counted_qty is None else float(ln.counted_qty)
        base = dict(
            id=ln.id, kind=ln.kind, part_unit_id=ln.part_unit_id, material_unit_id=ln.material_unit_id, part_id=ln.part_id,
            stage_id=ln.stage_id, expected_qty=exp, counted_qty=cnt, diff=pf.diff_of(exp, cnt), decision=ln.decision,
            allowed=pf.allowed_decisions(exp, cnt) if ln.decision is None else [], reason=ln.reason, note=ln.note,
            result_part_unit_id=ln.result_part_unit_id, manufactured_at=None, location_code=None, elsewhere=None,
            stage_name=None, lot=None, detail=None, group_name=None, item_id=ln.item_id,
        )
        if ln.kind == KIND_PF:
            part = parts.get(ln.part_id)
            item = items.get(part.item_id) if part and part.item_id else None
            unit = punits.get(ln.part_unit_id) if ln.part_unit_id else None
            st = stages.get(ln.stage_id)
            base.update(
                name=part.name if part else f"#{ln.part_id}", unit="шт", item_id=item.id if item else None,
                group_name=groups.get(item.group_id) if item and item.group_id else None,
                stage_name=st.name if st else "—", detail=st.name if st else None,
                lot=f"П-{ln.part_unit_id}" if ln.part_unit_id else None,
                manufactured_at=unit.manufactured_at.isoformat() if unit and unit.manufactured_at else None,
                location_code=unit.location_code if unit else None,
            )
        elif ln.kind == KIND_FILM:
            u = munits.get(ln.material_unit_id)
            sku = u.material_sku if u else None
            here = u is not None and (ln.expected_qty > 0 or svc.film_is_here(db, s, u))
            where = None
            if u is not None and not here:
                where = areas.get(u.area) if u.area else resolve_warehouse_name(wh, u.location_code) or u.status.value.replace("_", " ")
            base.update(
                name=sku_item_name(sku.material.name, sku.color.name, sku.thickness.value_mm, sku.manufacturer.name) if sku else "плёнка",
                unit="м", item_id=sku.item_id if sku else None, lot=f"№{ln.material_unit_id}",
                detail=f"{'штрипс' if u.is_strip else 'рулон'} {float(u.width_mm):g} мм" if u else None,
                location_code=u.location_code if u else None, elsewhere=where,
                manufactured_at=u.created_at.date().isoformat() if u and u.created_at else None,
            )
        else:
            item = items.get(ln.item_id)
            base.update(
                name=item.name if item else f"#{ln.item_id}", unit=item_unit(item) if item else "",
                group_name=groups.get(item.group_id) if item and item.group_id else None,
                detail=sites.get(ln.site_id) if ln.kind == KIND_FG else None,
            )
        out.append(LineOut(**base))
    order = {KIND_FILM: 0, KIND_PF: 1, KIND_MATERIAL: 2, KIND_FG: 3}
    # плёнка — по ячейке (идут вдоль стеллажей), прочее — по группе и названию
    out.sort(key=lambda x: (order.get(x.kind, 9), x.location_code or "яяя" if x.kind == KIND_FILM else "", x.group_name or "", x.name,
                            x.stage_name or "", x.manufactured_at or "", x.id))
    return out


def _detail(db: Session, s: PartCountSession, user: User) -> SessionDetail:
    lines = db.query(PartCountLine).filter(PartCountLine.session_id == s.id).all()
    return SessionDetail(**_summary(db, s, lines, user), lines=_lines_out(db, s, lines))


class PlaceOut(BaseModel):
    place_type: str
    place_ref: str | None
    name: str
    group: str
    kinds: list[str]


@router.get("/places", response_model=list[PlaceOut])
def places(db: Session = Depends(get_db), user: User = Depends(count_any)) -> list[PlaceOut]:
    """Места, которые этот пользователь может пересчитать, и что в них считается."""
    out: list[PlaceOut] = []
    if k := _kinds(user, PLACE_WAREHOUSE):
        for w in db.query(Warehouse).filter(Warehouse.is_active.is_(True)).order_by(Warehouse.name):
            out.append(PlaceOut(place_type=PLACE_WAREHOUSE, place_ref=str(w.id), name=w.name, group=PLACE_LABEL[PLACE_WAREHOUSE], kinds=k))
    if k := _kinds(user, PLACE_AREA):
        for a in db.query(Area).filter(Area.is_active.is_(True)).order_by(Area.name):
            out.append(PlaceOut(place_type=PLACE_AREA, place_ref=a.code, name=a.name, group=PLACE_LABEL[PLACE_AREA], kinds=k))
    if k := _kinds(user, PLACE_MATERIALS):
        out.append(PlaceOut(place_type=PLACE_MATERIALS, place_ref=None, name="Склад материалов", group=PLACE_LABEL[PLACE_MATERIALS], kinds=k))
    if k := _kinds(user, PLACE_FG):
        for site in db.query(Site).filter(Site.is_active.is_(True)).order_by(Site.name):
            out.append(PlaceOut(place_type=PLACE_FG, place_ref=str(site.id), name=f"Склад ГП · {site.name}", group=PLACE_LABEL[PLACE_FG], kinds=k))
    return out


@router.get("", response_model=list[SessionOut])
def list_sessions(db: Session = Depends(get_db), user: User = Depends(count_any)) -> list[SessionOut]:
    sessions = db.query(PartCountSession).order_by(PartCountSession.started_at.desc()).limit(200).all()
    out = []
    for s in sessions:
        if not _kinds(user, s.place_type):
            continue
        lines = db.query(PartCountLine).filter(PartCountLine.session_id == s.id).all()
        out.append(SessionOut(**_summary(db, s, lines, user)))
    return out


@router.post("", response_model=SessionDetail, status_code=status.HTTP_201_CREATED)
def start_session(payload: SessionCreate, db: Session = Depends(get_db), user: User = Depends(count_any)) -> SessionDetail:
    """Открыть инвентаризацию места: лист — всё, что там по учёту, тех видов,
    которые этот пользователь вправе считать."""
    place_type = payload.place_type
    ref = payload.place_ref if place_type != PLACE_AREA else (payload.place_ref or payload.area)
    if place_type not in PLACE_LABEL:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Неизвестное место")
    kinds = _kinds(user, place_type)
    if not kinds:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Нет прав на инвентаризацию этого места")
    if place_type == PLACE_AREA and (not ref or db.get(Area, ref) is None):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Участок не найден")
    if place_type == PLACE_WAREHOUSE and (not (ref or "").isdigit() or db.get(Warehouse, int(ref)) is None):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Склад не найден")
    if place_type == PLACE_FG and (not (ref or "").isdigit() or db.get(Site, int(ref)) is None):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Площадка не найдена")
    # одна открытая инвентаризация на место: расхождение берётся из листа, и
    # два листа одного места провели бы одну недостачу дважды (28.10)
    place_ref = ref if place_type != PLACE_MATERIALS else None
    busy = (
        db.query(PartCountSession.id)
        .filter(
            PartCountSession.status == COUNT_IN_PROGRESS,
            PartCountSession.place_type == place_type,
            # у участка — по area: в пересчётах п/ф до 27.10 place_ref пуст
            PartCountSession.area == ref if place_type == PLACE_AREA
            else PartCountSession.place_ref.is_(None) if place_ref is None
            else PartCountSession.place_ref == place_ref,
        )
        .first()
    )
    if busy:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"По этому месту уже идёт инвентаризация №{busy.id} — продолжите её или отмените"
        )
    scope = payload.scope.model_dump() if (payload.scope.group_ids or payload.scope.stages) else None
    s = PartCountSession(
        place_type=place_type, place_ref=place_ref,
        area=ref if place_type == PLACE_AREA else None, scope=scope if place_type == PLACE_AREA else None,
        status=COUNT_IN_PROGRESS, note=payload.note, started_by=user.id,
    )
    db.add(s)
    db.flush()
    svc.build_lines(db, s, kinds)
    db.commit()
    return _detail(db, s, user)


@router.get("/{session_id}", response_model=SessionDetail)
def get_session(session_id: int, db: Session = Depends(get_db), user: User = Depends(count_any)) -> SessionDetail:
    return _detail(db, _session(db, session_id, user), user)


class CountIn(BaseModel):
    counted_qty: float | None = Field(default=None, ge=0)


def _set_count(db: Session, s: PartCountSession, line: PartCountLine, qty: float | None, user: User) -> None:
    if not (line.kind == KIND_PF and line.part_unit_id is None):
        line.expected_qty = svc.current_expected(db, s, line)
    line.counted_qty = qty
    line.counted_by = user.id if qty is not None else None
    line.counted_at = datetime.now(timezone.utc) if qty is not None else None


@router.put("/{session_id}/lines/{line_id}", response_model=SessionDetail)
def set_count(
    session_id: int, line_id: int, payload: CountIn, db: Session = Depends(get_db), user: User = Depends(count_any)
) -> SessionDetail:
    """Факт по строке. «По учёту» обновляется в этот момент — если успели
    отчитаться, выдать или отгрузить после открытия, сравниваем с тем, что
    числилось сейчас."""
    s = _session(db, session_id, user)
    if s.status != COUNT_IN_PROGRESS:
        raise HTTPException(status.HTTP_409_CONFLICT, "Пересчёт уже закрыт")
    _set_count(db, s, _line(db, s, line_id), payload.counted_qty, user)
    db.commit()
    return _detail(db, s, user)


class ExtraIn(BaseModel):
    kind: str = KIND_PF
    part_id: int | None = None
    item_id: int | None = None
    material_unit_id: int | None = None
    counted_qty: float | None = Field(default=None, gt=0)


@router.post("/{session_id}/lines", response_model=SessionDetail, status_code=status.HTTP_201_CREATED)
def add_extra(session_id: int, payload: ExtraIn, db: Session = Depends(get_db), user: User = Depends(count_any)) -> SessionDetail:
    """Найдено сверх листа: п/ф — деталь с операцией на этом участке;
    материал / изделие — позиция; плёнка — рулон по номеру бирки (если он
    уже в листе — просто отмечается найденным)."""
    s = _session(db, session_id, user)
    if s.status != COUNT_IN_PROGRESS:
        raise HTTPException(status.HTTP_409_CONFLICT, "Пересчёт уже закрыт")
    if payload.kind not in _kinds(user, s.place_type):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Этот вид в этом месте не считается")
    now = datetime.now(timezone.utc)
    if payload.kind == KIND_PF:
        if payload.part_id is None or not payload.counted_qty:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите деталь и количество")
        stage = pf.stage_at_area(db, payload.part_id, s.area)
        if stage is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "У этой детали нет операции на этом участке")
        db.add(PartCountLine(session_id=s.id, kind=KIND_PF, part_id=payload.part_id, stage_id=stage.id, expected_qty=0,
                             counted_qty=payload.counted_qty, counted_by=user.id, counted_at=now))
    elif payload.kind == KIND_FILM:
        unit = db.get(MaterialUnit, payload.material_unit_id) if payload.material_unit_id else None
        if unit is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Рулона с таким номером нет — заведите его приёмкой без документа")
        line = (
            db.query(PartCountLine)
            .filter(PartCountLine.session_id == s.id, PartCountLine.material_unit_id == unit.id)
            .first()
        )
        if line is not None:
            if line.counted_qty is None or payload.counted_qty:
                _set_count(db, s, line, payload.counted_qty or float(line.expected_qty), user)
        else:
            rem = svc.film_remaining(db, [unit])[unit.id] if unit.status.value != "Списан" else 0.0
            qty = payload.counted_qty or rem
            if not qty:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Рулон списан — укажите, сколько метров нашли")
            db.add(PartCountLine(session_id=s.id, kind=KIND_FILM, material_unit_id=unit.id, expected_qty=0,
                                 counted_qty=qty, counted_by=user.id, counted_at=now))
    else:
        item = db.get(Item, payload.item_id) if payload.item_id else None
        if item is None or not payload.counted_qty:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите позицию и количество")
        dup = db.query(PartCountLine).filter(PartCountLine.session_id == s.id, PartCountLine.item_id == item.id).first()
        if dup is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "Эта позиция уже в листе — введите факт в её строке")
        site_id = int(s.place_ref) if payload.kind == KIND_FG else None
        db.add(PartCountLine(session_id=s.id, kind=payload.kind, item_id=item.id, site_id=site_id, expected_qty=0,
                             counted_qty=payload.counted_qty, counted_by=user.id, counted_at=now))
    db.commit()
    return _detail(db, s, user)


@router.delete("/{session_id}/lines/{line_id}", response_model=SessionDetail)
def remove_extra(session_id: int, line_id: int, db: Session = Depends(get_db), user: User = Depends(count_any)) -> SessionDetail:
    s = _session(db, session_id, user)
    if s.status != COUNT_IN_PROGRESS:
        raise HTTPException(status.HTTP_409_CONFLICT, "Пересчёт уже закрыт")
    line = _line(db, s, line_id)
    if line.part_unit_id is not None or (line.kind != KIND_PF and float(line.expected_qty) > 0):
        raise HTTPException(status.HTTP_409_CONFLICT, "Строку из листа не удалить — введите факт 0")
    db.delete(line)
    db.commit()
    return _detail(db, s, user)


@router.post("/{session_id}/close", response_model=SessionDetail)
def close_session(session_id: int, db: Session = Depends(get_db), user: User = Depends(count_any)) -> SessionDetail:
    """Закрыть пересчёт: факт больше не меняется, по расхождениям —
    решения. Не посчитанные строки остаются как по учёту."""
    s = _session(db, session_id, user)
    if s.status != COUNT_IN_PROGRESS:
        raise HTTPException(status.HTTP_409_CONFLICT, "Пересчёт уже закрыт")
    s.status = COUNT_CLOSED
    s.closed_by = user.id
    s.closed_at = datetime.now(timezone.utc)
    db.commit()
    return _detail(db, s, user)


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_session(session_id: int, db: Session = Depends(get_db), user: User = Depends(count_any)) -> None:
    """Отменить пересчёт, пока он открыт, — ничего ещё не применялось."""
    s = _session(db, session_id, user)
    if s.status != COUNT_IN_PROGRESS:
        raise HTTPException(status.HTTP_409_CONFLICT, "Закрытый пересчёт не отменяется")
    db.query(PartCountLine).filter(PartCountLine.session_id == s.id).delete()
    db.delete(s)
    db.commit()


class ResolveIn(BaseModel):
    decision: str
    reason: str | None = None
    note: str | None = Field(default=None, max_length=200)


def _resolve_one(db: Session, s: PartCountSession, line: PartCountLine, payload: ResolveIn, user: User) -> None:
    if line.decision is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "По строке уже принято решение")
    try:
        svc.resolve_line(db, session=s, line=line, decision=payload.decision, reason=payload.reason, note=payload.note, user_id=user.id)
    except ValueError as e:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e


@router.post("/{session_id}/lines/{line_id}/resolve", response_model=SessionDetail)
def resolve(
    session_id: int, line_id: int, payload: ResolveIn, db: Session = Depends(get_db), user: User = Depends(count_any)
) -> SessionDetail:
    """Решение по расхождению закрытого пересчёта: списать недостачу,
    оприходовать излишек или оставить учёт как есть — запись в журнал с
    номером инвентаризации."""
    s = _session(db, session_id, user)
    if s.status != COUNT_CLOSED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Сначала закройте пересчёт")
    _resolve_one(db, s, _line(db, s, line_id), payload, user)
    db.commit()
    return _detail(db, s, user)


class ResolveAllIn(ResolveIn):
    line_ids: list[int] = Field(min_length=1)


@router.post("/{session_id}/resolve", response_model=SessionDetail)
def resolve_many(session_id: int, payload: ResolveAllIn, db: Session = Depends(get_db), user: User = Depends(count_any)) -> SessionDetail:
    """Одно решение сразу по многим строкам («списать все недостачи»,
    «оприходовать все излишки») — всё или ничего."""
    s = _session(db, session_id, user)
    if s.status != COUNT_CLOSED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Сначала закройте пересчёт")
    for line_id in payload.line_ids:
        _resolve_one(db, s, _line(db, s, line_id), payload, user)
    db.commit()
    return _detail(db, s, user)


class AreaPartOut(BaseModel):
    part_id: int
    part_name: str
    stage_name: str


@router.get("/area-parts/{area}", response_model=list[AreaPartOut])
def area_parts(area: str, db: Session = Depends(get_db), user: User = Depends(count_any)) -> list[AreaPartOut]:
    """Детали, у которых есть операция на участке, — выбор для «найдено сверх листа»."""
    rows = (
        db.query(Part.id, Part.name, PartStage.name, PartStage.sequence_order)
        .join(PartStage, PartStage.part_id == Part.id)
        .filter(PartStage.area == area, Part.is_active.is_(True))
        .order_by(Part.name, PartStage.sequence_order.desc())
        .all()
    )
    seen: dict[int, AreaPartOut] = {}
    for pid, pname, sname, _ in rows:
        seen.setdefault(pid, AreaPartOut(part_id=pid, part_name=pname, stage_name=sname))
    return list(seen.values())
