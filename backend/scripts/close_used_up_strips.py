"""Закрыть штрипсы, израсходованные в ноль по отчётам «+ ещё рулон» (09.10.2026).

До 09.10 отчёт «доп. рулон, остаток 0 м» не закрывал штрипс: он оставался
«выдан участку» с полной длиной и ждал возврата, которого физически нет.
Скрипт делает с такими штрипсами то же, что теперь делает отчёт: раскрой до
нуля — расход, не брак. Берутся только штрипсы, которые после отчёта «0 м»
не выдавались снова и по которым потом не было отчётов. Дата операции —
время отчёта; если оно в закрытом периоде — сегодня.

Без --apply только показывает список и итог.

    .venv\\Scripts\\python scripts\\close_used_up_strips.py [--apply]
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from sqlalchemy import func  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.models.events import EventType, MaterialEvent  # noqa: E402
from app.models.production import REPORT_REMAINDER, ProductionTaskLineReport  # noqa: E402
from app.models.units import MaterialUnit, UnitStatus  # noqa: E402
from app.models.users import User  # noqa: E402
from app.services.events import record_event  # noqa: E402
from app.services.period_guard import TZ, closed_until  # noqa: E402
from app.services.splitting import cut_to_length  # noqa: E402


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    admin = db.query(User).filter(User.username == "admin").first()
    closed = closed_until(db)
    zero = {}
    for uid, at in (
        db.query(ProductionTaskLineReport.material_unit_id, func.max(ProductionTaskLineReport.reported_at))
        .filter(ProductionTaskLineReport.kind == REPORT_REMAINDER, ProductionTaskLineReport.note.op("~")(r": 0 м$"))
        .group_by(ProductionTaskLineReport.material_unit_id)
    ):
        zero[uid] = at
    done, skipped, meters, m2 = 0, [], 0.0, 0.0
    for uid, at in sorted(zero.items()):
        unit = db.get(MaterialUnit, uid)
        if unit is None or unit.status != UnitStatus.VYDAN_UCHASTKU or float(unit.length_m) <= 0:
            continue
        last_issue = (
            db.query(func.max(MaterialEvent.timestamp))
            .filter(MaterialEvent.unit_id == uid, MaterialEvent.event_type == EventType.VYDACHA_UCHASTKU)
            .scalar()
        )
        later = (
            db.query(ProductionTaskLineReport.id)
            .filter(ProductionTaskLineReport.material_unit_id == uid, ProductionTaskLineReport.reported_at > at)
            .first()
        )
        if (last_issue and last_issue > at) or later:
            skipped.append(uid)
            continue
        length = float(unit.length_m)
        meters += length
        m2 += length * float(unit.width_mm) / 1000
        done += 1
        when = at if closed is None or at.astimezone(TZ).date() > closed else datetime.now(timezone.utc)
        print(f"ПЛ-{uid}: {length:g} м × {float(unit.width_mm):g} мм, отчёт «0 м» {at.astimezone(TZ):%d.%m %H:%M}")
        if apply:
            outcome = cut_to_length(unit, length)
            unit.length_m = outcome.parent_length_m
            unit.status = outcome.parent_status
            record_event(
                db, unit=unit, event_type=outcome.parent_event.event_type, user_id=admin.id,
                quantity_delta_m=outcome.parent_event.quantity_delta_m,
                from_length=outcome.parent_event.from_length, to_length=outcome.parent_event.to_length,
                occurred_at=when,
            )
    print(f"Итого: {done} штрипсов, {meters:.1f} м, {m2:.1f} м²; пропущено (выдавались снова / отчёты позже): {skipped}")
    if apply:
        db.commit()
        print("Записано.")
    else:
        db.rollback()
        print("Без записи. Для записи — --apply.")


if __name__ == "__main__":
    main()
