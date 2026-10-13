"""Пробный запуск заказа (13.10) — одно правило для всех оценок до запуска.

«Проверить срок» (order_requests), потребность по заказам (order_needs),
загрузка плана недели и «Запустить неделю» (weekly_plan) запускают заказ
так же, как настоящий запуск: задания по маршрутам, п/ф под заказ по
расчёту, одинаковые строки п/ф — одной, сроки. Раньше у каждого была своя
копия — правило запуска поменяли бы в одном месте, оценки разошлись бы.

Ничего не сохраняет сам: вызывающий запускает внутри точки сохранения
(db.begin_nested()) и откатывает, или — для «Запустить неделю» — берёт
только default_picks и вызывает настоящий запуск."""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from sqlalchemy.orm import Session

from app.models.production import ProductionTask
from app.models.production_orders import ProductionOrder


def default_picks(db: Session, order: ProductionOrder) -> list:
    """П/ф под заказ без окна запуска: сколько со склада и в работу — как
    предлагает расчёт; ламинация панели — на Фабрику при партии от порога
    участка («По размеру партии»), иначе по маршруту."""
    from app.services.planning import PfPick, order_pf_needs

    needs = order_pf_needs(db, order)
    per_part: dict[int, float] = defaultdict(float)
    for n in needs:
        per_part[n.part_id] += n.launch
    picks = []
    for n in needs:
        lam = None
        if n.lamination_area:
            big = n.factory_area and n.factory_min_pieces and per_part[n.part_id] >= n.factory_min_pieces
            lam = n.factory_area if big else n.lamination_area
        picks.append(PfPick(order_line_id=n.order_line_id, part_id=n.part_id, quantity=n.launch,
                            consumer_part_id=n.consumer_part_id, lamination_area=lam, from_stock=n.from_stock))
    return picks


@dataclass
class Trial:
    tasks: list[ProductionTask]
    finish: date | None
    late: bool
    dates: dict[int, date]  # строка задания → день


def trial_release(db: Session, order: ProductionOrder, user_id: int, *, from_today: bool = False, today: date | None = None) -> Trial:
    """Запустить заказ в текущей транзакции (откат — у вызывающего).
    from_today — сроки от сегодня, а не назад от обещанной даты: «когда
    раньше всего может быть готово». OrderError — пробрасывается."""
    from app.services.planning import release_pf, schedule_order
    from app.services.production_orders import release_order
    from app.services.release_merge import merge_pf_lines

    tasks = release_order(db, order, user_id)
    tasks += release_pf(db, order, tasks, default_picks(db, order), user_id)
    merge_pf_lines(db, order)
    if from_today:
        ship, ready = order.ship_date, order.promised_ready
        order.ship_date, order.promised_ready = None, None
        sched = schedule_order(db, order, user_id, today=today)
        order.ship_date, order.promised_ready = ship, ready
    else:
        sched = schedule_order(db, order, user_id, today=today)
    return Trial(tasks=tasks, finish=sched.finish, late=sched.late, dates=sched.dates)
