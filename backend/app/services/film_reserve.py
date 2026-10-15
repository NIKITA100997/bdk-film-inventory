"""Резерв плёнки под заказ (15.10) — метры на конкретных рулонах склада.

Когда ставится: при запуске заказа в производство (строки заданий с
плёнкой) и кнопкой у срочного заказа клиента до запуска. Сколько: план ×
длина детали × (1 + запас %) — запас на брак, пусковые и сделанное сверх
заказа (по факту окутки за 60 дней ~5,5 % + 6,5 %), минус уже выданное и
уже закреплённое. Где: склад площадки участка; сначала готовые штрипсы
нужной ширины, потом начатые рулоны, потом самые старые. Шире штрипса —
рулон режется: метров рулона = метров штрипса / сколько штрипсов в ширину.

Что держит: пока резерв активен, эти метры не выдают и не режут под
другой заказ (guard_take). Выдача под свою строку превращает резерв в
«использован». Снимается при отмене/закрытии; перехватить чужой — только
с правом film_reserve.override (начальник цеха), с записью кто и почему.
Вся функция включается настройкой (app_settings "film_reserve")."""

import math
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.film_reserve import RES_ACTIVE, RES_RELEASED, RES_TAKEN, RES_USED, FilmReservation
from app.models.integrations import AppSetting
from app.models.production import ProductionTask, ProductionTaskLine
from app.models.units import MaterialSku, MaterialUnit, UnitStatus
from app.models.users import User

KEY = "film_reserve"
DEFAULTS = {"enabled": False, "extra_pct": 12.0}
OVERRIDE = "film_reserve.override"
EPS = 0.01


def get_settings(db: Session) -> dict:
    row = db.get(AppSetting, KEY)
    return {**DEFAULTS, **(row.value if row is not None and isinstance(row.value, dict) else {})}


def save_settings(db: Session, value: dict, user_id: int) -> None:
    row = db.get(AppSetting, KEY)
    if row is None:
        row = AppSetting(key=KEY)
        db.add(row)
    row.value = {**get_settings(db), **value}
    row.updated_by = user_id
    db.flush()


def enabled(db: Session) -> bool:
    return bool(get_settings(db).get("enabled"))


def can_override(user: User) -> bool:
    from app.core.security import get_permission_codes

    return bool(user.is_superuser or OVERRIDE in get_permission_codes(user))


def _strip_width(line: ProductionTaskLine) -> float:
    from app.services.production import calc_default_strip_width

    return float(line.strip_width_mm) if line.strip_width_mm is not None else calc_default_strip_width(line.part_name, float(line.width_mm))


def active_on_unit(db: Session, unit_id: int) -> list[FilmReservation]:
    return db.query(FilmReservation).filter(FilmReservation.unit_id == unit_id, FilmReservation.status == RES_ACTIVE).all()


def blocked_for(db: Session, unit: MaterialUnit, take_m: float, line_id: int | None) -> bool:
    """Автоподбор: единица не подходит, если забрать take_m можно только из чужого резерва."""
    if not enabled(db):
        return False
    others = sum(float(r.length_m) for r in active_on_unit(db, unit.id) if r.task_line_id is None or r.task_line_id != line_id)
    return others > EPS and take_m > float(unit.length_m) - others + EPS


def reserved_m(db: Session, unit_id: int, exclude_line_id: int | None = None) -> float:
    return sum(float(r.length_m) for r in active_on_unit(db, unit_id) if exclude_line_id is None or r.task_line_id != exclude_line_id)


def _roll_meters(unit: MaterialUnit, strip_w: float, strip_m: float, same_width: bool) -> float:
    """Сколько метров рулона уйдёт на strip_m метров штрипса ширины strip_w."""
    if same_width:
        return strip_m
    per_width = max(1, math.floor(float(unit.width_mm) / strip_w + 1e-6))
    return strip_m / per_width


@dataclass
class Need:
    material_id: int
    color_id: int
    thickness_id: int
    strip_w: float
    meters: float  # метров штрипса, которые надо закрепить
    home_warehouse_id: int | None
    task_line_id: int | None = None
    customer_order_id: int | None = None


def _candidates(db: Session, need: Need) -> list[MaterialUnit]:
    from app.services.warehouses import filter_by_warehouse
    from app.services.width_analogs import equivalent_widths

    skus = [s for (s,) in db.query(MaterialSku.id).filter(
        MaterialSku.material_id == need.material_id, MaterialSku.color_id == need.color_id, MaterialSku.thickness_id == need.thickness_id
    )]
    if not skus:
        return []
    q = db.query(MaterialUnit).filter(
        MaterialUnit.status == UnitStatus.NA_KHRANENII,
        MaterialUnit.material_sku_id.in_(skus),
        MaterialUnit.width_mm >= need.strip_w - EPS,
        # единица, уже выданная под другую строку (едет/лежит на Фабрике), — не трогаем
        (MaterialUnit.production_task_line_id.is_(None)) | (MaterialUnit.production_task_line_id == (need.task_line_id or -1)),
    )
    q = filter_by_warehouse(q, MaterialUnit.location_code, db, need.home_warehouse_id)
    equiv = set(equivalent_widths(db, need.strip_w))
    units = q.all()
    # готовые штрипсы нужной ширины → начатые (штрипс/остаток) → старые
    return sorted(units, key=lambda u: (float(u.width_mm) not in equiv, not (u.is_strip or u.parent_id), u.created_at))


def reserve(db: Session, need: Need, user_id: int) -> tuple[float, float]:
    """Закрепить need.meters (метров штрипса). Возвращает (закреплено м², не хватило м²)."""
    from app.services.width_analogs import equivalent_widths

    equiv = set(equivalent_widths(db, need.strip_w))
    left = need.meters
    got_m2 = 0.0
    for u in _candidates(db, need):
        if left <= EPS:
            break
        same = float(u.width_mm) in equiv
        free_roll = float(u.length_m) - reserved_m(db, u.id)
        if free_roll <= EPS:
            continue
        per_width = 1 if same else max(1, math.floor(float(u.width_mm) / need.strip_w + 1e-6))
        take_strip = min(left, free_roll * per_width)
        take_roll = _roll_meters(u, need.strip_w, take_strip, same)
        # м² — плёнки в заказ (штрипс), без обрези рулона: так сходится с потребностью
        area = take_strip * need.strip_w / 1000
        db.add(FilmReservation(
            unit_id=u.id, length_m=round(take_roll, 3), area_m2=round(area, 3), task_line_id=need.task_line_id,
            customer_order_id=need.customer_order_id, strip_width_mm=need.strip_w, created_by=user_id,
        ))
        db.flush()
        left -= take_strip
        got_m2 += take_strip * need.strip_w / 1000
    return round(got_m2, 3), round(max(0.0, left) * need.strip_w / 1000, 3)


def _issued_m(db: Session, line_id: int) -> float:
    return sum(float(l) for (l,) in db.query(MaterialUnit.length_m).filter(MaterialUnit.production_task_line_id == line_id))


def _line_reserved_m2(db: Session, line_id: int) -> float:
    return sum(
        float(r.area_m2) for r in db.query(FilmReservation).filter(FilmReservation.task_line_id == line_id, FilmReservation.status == RES_ACTIVE)
    )


def reserve_lines(db: Session, lines: list[ProductionTaskLine], user_id: int) -> dict:
    """Закрепить плёнку под строки заданий (запуск заказа). Без commit."""
    from app.services.warehouses import area_home_warehouse_id

    pct = float(get_settings(db).get("extra_pct") or 0) / 100
    out = {"reserved_m2": 0.0, "short_m2": 0.0, "lines": 0}
    for ln in lines:
        if ln.material_id is None or ln.is_closed:
            continue
        sw = _strip_width(ln)
        need_m = float(ln.quantity_pieces) * float(ln.length_m) * (1 + pct)
        have_m = _issued_m(db, ln.id) + _line_reserved_m2(db, ln.id) * 1000 / sw
        if need_m - have_m <= EPS:
            continue
        got, short = reserve(db, Need(ln.material_id, ln.color_id, ln.thickness_id, sw, need_m - have_m,
                                      area_home_warehouse_id(db, ln.task.area), task_line_id=ln.id), user_id)
        out["reserved_m2"] += got
        out["short_m2"] += short
        out["lines"] += 1
    return {k: round(v, 2) if isinstance(v, float) else v for k, v in out.items()}


def reserve_customer_order(db: Session, co, user_id: int) -> dict:
    """Кнопка у срочного заказа клиента (до запуска): пробный запуск в точке
    сохранения → какие строки с плёнкой будут → откат → закрепить по ним
    метры за заказом клиента. При запуске заказа этот резерв переходит в
    резерв строк заданий."""
    from app.services.customer_orders import transient_production_order
    from app.services.trial_release import trial_release
    from app.services.warehouses import area_home_warehouse_id

    pct = float(get_settings(db).get("extra_pct") or 0) / 100
    needs: list[Need] = []
    sp = db.begin_nested()
    try:
        po = transient_production_order(db, co, user_id)
        if po is not None:
            trial = trial_release(db, po, user_id)
            for t in trial.tasks:
                for ln in t.lines:
                    if ln.material_id is None:
                        continue
                    needs.append(Need(ln.material_id, ln.color_id, ln.thickness_id, _strip_width(ln),
                                      float(ln.quantity_pieces) * float(ln.length_m) * (1 + pct),
                                      area_home_warehouse_id(db, t.area), customer_order_id=co.id))
    finally:
        sp.rollback()
    # уже закреплённое за этим заказом — не дублировать
    have: dict[tuple, float] = {}
    for r in db.query(FilmReservation).filter(FilmReservation.customer_order_id == co.id, FilmReservation.status == RES_ACTIVE):
        u = db.get(MaterialUnit, r.unit_id)
        sku = u.material_sku
        key = (sku.material_id, sku.color_id, sku.thickness_id, float(r.strip_width_mm or 0))
        have[key] = have.get(key, 0.0) + float(r.area_m2) * 1000 / float(r.strip_width_mm or u.width_mm)
    out = {"reserved_m2": 0.0, "short_m2": 0.0, "lines": 0}
    for n in needs:
        key = (n.material_id, n.color_id, n.thickness_id, n.strip_w)
        already = min(have.get(key, 0.0), n.meters)
        have[key] = have.get(key, 0.0) - already
        n.meters -= already
        if n.meters <= EPS:
            continue
        got, short = reserve(db, n, user_id)
        out["reserved_m2"] += got
        out["short_m2"] += short
        out["lines"] += 1
    return {k: round(v, 2) if isinstance(v, float) else v for k, v in out.items()}


def _close(rows: list[FilmReservation], status_: str, user_id: int | None, note: str | None) -> int:
    now = datetime.now(timezone.utc)
    for r in rows:
        r.status, r.closed_at, r.closed_by = status_, now, user_id
        if note:
            r.note = note[:255]
    return len(rows)


def release_lines(db: Session, line_ids: list[int], user_id: int | None, note: str) -> int:
    if not line_ids:
        return 0
    rows = db.query(FilmReservation).filter(FilmReservation.task_line_id.in_(line_ids), FilmReservation.status == RES_ACTIVE).all()
    return _close(rows, RES_RELEASED, user_id, note)


def release_task(db: Session, task: ProductionTask, user_id: int | None, note: str) -> int:
    return release_lines(db, [ln.id for ln in task.lines], user_id, note)


def release_customer_order(db: Session, co_id: int, user_id: int | None, note: str) -> int:
    rows = db.query(FilmReservation).filter(FilmReservation.customer_order_id == co_id, FilmReservation.task_line_id.is_(None),
                                             FilmReservation.status == RES_ACTIVE).all()
    return _close(rows, RES_RELEASED, user_id, note)


def on_issue(db: Session, unit: MaterialUnit, line_id: int | None, user_id: int) -> None:
    """Единица выдана (или разрезана) под строку: её резерв под эту строку —
    использован; закреплённое за строкой на других рулонах уменьшается на
    выданное (больше не нужно держать)."""
    if line_id is None:
        return
    issued_m2 = float(unit.width_mm) * float(unit.length_m) / 1000
    rows = db.query(FilmReservation).filter(FilmReservation.task_line_id == line_id, FilmReservation.status == RES_ACTIVE).all()
    rows.sort(key=lambda r: r.unit_id != unit.id)
    for r in rows:
        if issued_m2 <= EPS:
            break
        if float(r.area_m2) <= issued_m2 + EPS or r.unit_id == unit.id:
            issued_m2 -= float(r.area_m2)
            _close([r], RES_USED, user_id, None)
        else:
            k = (float(r.area_m2) - issued_m2) / float(r.area_m2)
            r.area_m2 = round(float(r.area_m2) * k, 3)
            r.length_m = round(float(r.length_m) * k, 3)
            issued_m2 = 0.0


def consume_on_cut(db: Session, unit: MaterialUnit, line_ids: set[int], user_id: int) -> None:
    """Режут под свои строки — резерв этих строк на этом рулоне использован."""
    if not line_ids:
        return
    _close([r for r in active_on_unit(db, unit.id) if r.task_line_id in line_ids], RES_USED, user_id, None)


def guard_take(db: Session, unit: MaterialUnit, take_m: float, line_ids: set[int | None], user: User, what: str) -> None:
    """Можно ли забрать take_m метров с единицы под строку line_id: чужой
    резерв (под другую строку или заказ клиента) не трогаем. С правом
    перехвата — забираем, резерв помечается «перехвачен» с причиной."""
    if not enabled(db):
        return
    others = [r for r in active_on_unit(db, unit.id) if r.task_line_id is None or r.task_line_id not in line_ids]
    if not others:
        return
    allowed = float(unit.length_m) - sum(float(r.length_m) for r in others)
    if take_m <= allowed + EPS:
        return
    if not can_override(user):
        raise HTTPException(status.HTTP_409_CONFLICT, f"{what}: на рулоне резерв под {describe(db, others)}. Снять или перехватить резерв может начальник цеха")
    need = take_m - allowed
    for r in sorted(others, key=lambda x: float(x.length_m)):
        if need <= EPS:
            break
        need -= float(r.length_m)
        _close([r], RES_TAKEN, user.id, f"перехвачен: {what}")


def describe(db: Session, rows: list[FilmReservation]) -> str:
    from app.models.customer_orders import CustomerOrder

    parts = []
    for r in rows:
        if r.task_line_id:
            ln = db.get(ProductionTaskLine, r.task_line_id)
            parts.append(f"{(ln.task.name if ln and ln.task else None) or f'задание №{ln.task_id if ln else "?"}'} ({float(r.length_m):g} м)")
        elif r.customer_order_id:
            co = db.get(CustomerOrder, r.customer_order_id)
            parts.append(f"заказ {co.invoice_no if co else r.customer_order_id} ({float(r.length_m):g} м)")
    return ", ".join(parts)


def loss_stats(db: Session, days: int = 60) -> dict:
    """Факт за период: брак (с пусковыми) и сделанное сверх плана — основа
    для запаса %."""
    from sqlalchemy import text

    row = db.execute(text("""
        select coalesce(sum(case when r.counts_toward_line then r.good_pieces else 0 end), 0),
               coalesce(sum(case when r.counts_toward_line then r.defect_pieces else 0 end), 0),
               coalesce(sum(case when r.counts_toward_line and r.defect_reason = 'puskovye' then r.defect_pieces else 0 end), 0)
        from production_task_line_reports r join production_task_lines l on l.id = r.task_line_id
        where l.material_id is not null and r.reported_at > now() - make_interval(days => :d)
    """), {"d": days}).one()
    good, defect, start = (float(x) for x in row)
    over = db.execute(text("""
        with g as (select l.id, l.quantity_pieces q, sum(case when r.counts_toward_line then r.good_pieces else 0 end) good
          from production_task_lines l join production_task_line_reports r on r.task_line_id = l.id
          where l.material_id is not null and r.reported_at > now() - make_interval(days => :d) group by l.id, l.quantity_pieces)
        select coalesce(sum(q), 0), coalesce(sum(greatest(good - q, 0)), 0) from g
    """), {"d": days}).one()
    plan, overmade = (float(x) for x in over)
    defect_pct = 100 * defect / max(1.0, good + defect)
    over_pct = 100 * overmade / max(1.0, plan)
    return {
        "days": days, "defect_pct": round(defect_pct, 1), "startup_pct": round(100 * start / max(1.0, good + defect), 1),
        "over_plan_pct": round(over_pct, 1), "suggested_pct": round(defect_pct + over_pct),
    }
