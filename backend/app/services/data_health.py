"""Контроль данных (19.10): противоречия, которые не видны в работе, —
рулоны без места, статус против журнала, сдано сверх плана, повторные
отчёты, пустые партии п/ф, резервы на ушедших рулонах, минус на складе ГП.
Считается по запросу, кэш на 10 минут — для блока на «Обзоре»."""

import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.events import EventType, MaterialEvent
from app.models.film_reserve import RES_ACTIVE, FilmReservation
from app.models.finished_goods import FgMove
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.units import MaterialUnit, UnitStatus

_CACHE: dict = {}
TTL_S = 600


def _check(key, title, count, hint, path=None, level="warning", examples=None) -> dict:
    return {"key": key, "title": title, "count": count, "level": "ok" if count == 0 else level,
            "hint": hint, "path": path, "examples": (examples or [])[:8]}


def data_health(db: Session, refresh: bool = False) -> dict:
    hit = _CACHE.get("v")
    if hit and not refresh and time.time() - hit[0] < TTL_S:
        return hit[1]
    now = datetime.now(timezone.utc)
    st = UnitStatus
    out: list[dict] = []

    no_cell = db.query(MaterialUnit.id).filter(MaterialUnit.status.in_([st.NA_KHRANENII, st.PRINYAT]), MaterialUnit.location_code.is_(None)).all()
    out.append(_check("no_cell", "Рулоны и штрипсы на складе без ячейки", len(no_cell),
                      "Разместите: карточка рулона → «Разместить» или блок «Без места» ниже", "/stock", examples=[f"ПЛ-{i}" for (i,) in no_cell]))

    from app.models.storage import Warehouse

    defaults = [w.default_cell for w in db.query(Warehouse).filter(Warehouse.default_cell.isnot(None))]
    on_default = db.query(func.count(MaterialUnit.id)).filter(MaterialUnit.status.in_([st.NA_KHRANENII, st.PRINYAT]),
                                                              MaterialUnit.location_code.in_(defaults or ["-"])).scalar()
    out.append(_check("on_default", f"Лежат на месте по умолчанию ({', '.join(defaults) or '—'})", int(on_default or 0),
                      "Не ошибка: сюда встаёт всё без выбранной ячейки. Разложите по стеллажам, когда будет время", "/stock", level="info"))

    stale = db.query(MaterialUnit.id).filter(MaterialUnit.status == st.PRINYAT, MaterialUnit.created_at < now - timedelta(days=2)).all()
    out.append(_check("stale_received", "Приняты, но не размещены дольше 2 дней", len(stale), "Разместите в ячейку", "/stock",
                      examples=[f"ПЛ-{i}" for (i,) in stale]))

    issued_no_area = db.query(MaterialUnit.id).filter(MaterialUnit.status == st.VYDAN_UCHASTKU, MaterialUnit.area.is_(None)).all()
    out.append(_check("issued_no_area", "Выданы участку, но участок не указан", len(issued_no_area), "Откройте карточку и выдайте заново или верните",
                      level="error", examples=[f"ПЛ-{i}" for (i,) in issued_no_area]))

    bad_len = db.query(MaterialUnit.id).filter(MaterialUnit.status != st.SPISAN, MaterialUnit.length_m <= 0.001).all()
    out.append(_check("zero_length", "Длина 0 или меньше, но рулон не списан", len(bad_len), "Спишите остаток в карточке рулона",
                      level="error", examples=[f"ПЛ-{i}" for (i,) in bad_len]))

    # последнее событие против статуса
    last_ev = (
        db.query(MaterialEvent.unit_id, MaterialEvent.event_type)
        .distinct(MaterialEvent.unit_id)
        .order_by(MaterialEvent.unit_id, MaterialEvent.timestamp.desc(), MaterialEvent.event_id.desc())
        .all()
    )
    status_by_id = dict(db.query(MaterialUnit.id, MaterialUnit.status).all())
    mism = [uid for uid, et in last_ev if status_by_id.get(uid) in (st.NA_KHRANENII, st.PRINYAT)
            and et in (EventType.VYDACHA_UCHASTKU, EventType.SPISANIE)]
    out.append(_check("status_journal", "Статус рулона не сходится с журналом", len(mism),
                      "На складе, а последнее действие — выдача или списание: проверьте карточку", level="error",
                      examples=[f"ПЛ-{i}" for i in mism]))

    res = db.query(FilmReservation).filter(FilmReservation.status == RES_ACTIVE).all()
    bad_res = []
    for r in res:
        uid = getattr(r, "unit_id", None) or getattr(r, "material_unit_id", None)
        if uid and status_by_id.get(uid) not in (st.NA_KHRANENII, st.PRINYAT, None):
            bad_res.append(r.id)
        ln = db.get(ProductionTaskLine, r.task_line_id) if getattr(r, "task_line_id", None) else None
        if ln is not None and (ln.is_closed or not db.get(ProductionTask, ln.task_id).is_active):
            bad_res.append(r.id)
    out.append(_check("stale_reserve", "Резерв держит рулон, который уже не на складе или строка закрыта", len(set(bad_res)),
                      "Снимите резерв: доска выдачи → «Резерв»", "/production-tasks?tab=film-issue&sub=reserve"))

    # сдано сверх плана больше чем на 10 % — по открытым заданиям
    over = []
    rows = (
        db.query(ProductionTaskLine, func.sum(ProductionTaskLineReport.good_pieces))
        .join(ProductionTaskLineReport, ProductionTaskLineReport.task_line_id == ProductionTaskLine.id)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTask.is_active.is_(True), ProductionTaskLineReport.counts_toward_line.is_(True))
        .group_by(ProductionTaskLine.id)
        .all()
    )
    for ln, good in rows:
        plan = float(ln.quantity_pieces)
        if plan > 0 and float(good) > plan * 1.1 + 1e-6:
            over.append(f"задание №{ln.task_id}: {ln.part_name or 'строка'} — план {plan:g}, сдано {float(good):g}")
    out.append(_check("over_plan", "Сдано больше плана больше чем на 10 % (открытые задания)", len(over),
                      "Сверьте с мастером: перевыпуск или ошибка в отчёте", "/production-tasks?tab=tasks", examples=over))

    # повторы: тот же человек, та же строка, то же количество за 2 минуты — за 7 дней
    since = now - timedelta(days=7)
    reps = (
        db.query(ProductionTaskLineReport)
        .filter(ProductionTaskLineReport.reported_at >= since, ProductionTaskLineReport.counts_toward_line.is_(True))
        .order_by(ProductionTaskLineReport.task_line_id, ProductionTaskLineReport.reported_by, ProductionTaskLineReport.reported_at)
        .all()
    )
    dups = []
    for a, b in zip(reps, reps[1:]):
        if (a.task_line_id == b.task_line_id and a.reported_by == b.reported_by
                and float(a.good_pieces) == float(b.good_pieces) and float(a.defect_pieces) == float(b.defect_pieces)
                and (a.defect_reason or "") == (b.defect_reason or "") and float(a.good_pieces) + float(a.defect_pieces) > 0
                and 2 <= (b.reported_at - a.reported_at).total_seconds() <= 120):
            dups.append(f"строка {b.task_line_id}: {float(b.good_pieces):g} годн. {b.reported_at.astimezone():%d.%m %H:%M}")
    out.append(_check("repeat_reports", "Одинаковые отчёты подряд за 2 минуты (7 дней)", len(dups),
                      "Возможно двойное нажатие — сверьте с мастером", "/production-tasks?tab=tasks", examples=dups))

    from app.services.part_units import reported_good_pieces_by_unit

    alive = db.query(PartUnit).filter(PartUnit.status.notin_([PartUnitStatus.SPISAN, PartUnitStatus.V_PERERABOTKU])).all()
    rep = reported_good_pieces_by_unit(db, [u.id for u in alive])
    empty = [u.id for u in alive if float(u.quantity_pieces) - rep.get(u.id, 0.0) <= 1e-6]
    out.append(_check("empty_lots", "Пустые партии п/ф не закрыты", len(empty), "Закрываются сами после отчёта; старые — разово",
                      level="info", examples=[f"ПФ-{i}" for i in empty]))

    neg_fg = db.query(FgMove.item_id).group_by(FgMove.item_id, FgMove.order_line_id).having(func.sum(FgMove.qty) < -0.001).all()
    out.append(_check("fg_negative", "Склад готовой продукции: отрицательный остаток", len(neg_fg),
                      "Отгружено больше, чем принято — проверьте движения", "/customer-orders?section=shipping", level="error"))

    data = {"checks": out, "checked_at": now.isoformat(), "problems": sum(1 for c in out if c["level"] in ("warning", "error"))}
    _CACHE["v"] = (time.time(), data)
    return data
