from datetime import date, datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.dictionaries import Part, PartStage
from app.models.part_units import PartEventType, PartUnit, PartUnitEvent, PartUnitStatus
from app.models.production import ProductionTaskLineReport


def record_part_event(
    db: Session,
    *,
    unit: PartUnit,
    event_type: PartEventType,
    user_id: int,
    quantity_delta: float = 0,
    from_stage_id: int | None = None,
    to_stage_id: int | None = None,
    from_cell: str | None = None,
    to_cell: str | None = None,
    write_off_reason: str | None = None,
    write_off_note: str | None = None,
    occurred_at: datetime | None = None,
    note: str | None = None,
) -> PartUnitEvent:
    """Единая точка записи в журнал партий (зеркалит services/events.py::
    record_event) — вызывается только отсюда, не роутерами напрямую."""
    event = PartUnitEvent(
        part_unit_id=unit.id,
        event_type=event_type,
        quantity_delta=quantity_delta,
        from_stage_id=from_stage_id,
        to_stage_id=to_stage_id,
        from_cell=from_cell,
        to_cell=to_cell,
        area=unit.area,
        production_task_line_id=unit.production_task_line_id,
        write_off_reason=write_off_reason,
        write_off_note=write_off_note,
        user_id=user_id,
        note=note,
        **({"occurred_at": occurred_at} if occurred_at is not None else {}),
    )
    db.add(event)
    return event


def place_part_unit(db: Session, *, unit: PartUnit, location_code: str, user_id: int) -> PartUnit:
    """Разместить партию на полку стеллажа п/ф (раздел про адресное
    хранение) — доступно, пока партия физически в цехе (На_хранении),
    зеркалит `place_unit` у плёнки. Взаимоисключимо с `area`
    (выдано участку), как у `MaterialUnit`."""
    if unit.status != PartUnitStatus.NA_KHRANENII:
        raise ValueError("Разместить на полку можно только партию, которая сейчас на хранении")
    from_cell = unit.location_code
    unit.location_code = location_code
    record_part_event(
        db,
        unit=unit,
        event_type=PartEventType.RAZMESHCHENIE,
        user_id=user_id,
        from_cell=from_cell,
        to_cell=location_code,
    )
    return unit


def mint_part_unit(
    db: Session,
    *,
    part: Part,
    quantity_pieces: float,
    user_id: int,
    production_task_line_id: int | None = None,
    issue: bool = False,
    note: str | None = None,
    stage_id: int | None = None,
    manufactured_at: date | None = None,
) -> PartUnit:
    """Регистрация факта нарезки партии (начальник цеха) — по умолчанию
    рождается на первом этапе детали (sequence_order=1). Деталь без
    настроенных этапов ещё не готова к физическому учёту — явная ошибка
    вместо тихого создания партии без этапа.

    `stage_id` — раздел про регистрацию задним числом: партия физически
    уже прошла часть маршрута (например, уже склеена и отфрезерована) и
    заводится в систему только сейчас — стартовым этапом становится он,
    а не обязательно первый. Явная ошибка, если этап не из списка этапов
    ЭТОЙ детали (а не просто существует у какой-то другой).

    `manufactured_at` — раздел про учёт п/ф по FIFO: дата, по которой
    партия расходуется (не дата записи в систему) — тот же приём
    "задним числом", что и у stage_id; None — сегодня.

    Раздел про связь этапов с участками — участок выдачи выводится из
    `start_stage.area`, не выбирается вручную (см. PartStage.area):
    начальник цеха выбирает ТОЛЬКО факт "сразу выдать участку", куда
    именно — определяет сам этап."""
    if not part.stages:
        raise ValueError(f"У детали «{part.name}» не настроены этапы — добавьте их в справочнике «Деталь»")
    if stage_id is not None:
        start_stage = next((s for s in part.stages if s.id == stage_id), None)
        if start_stage is None:
            raise ValueError(f"Этап не найден среди этапов детали «{part.name}»")
    else:
        start_stage = part.stages[0]
    if issue and not start_stage.area:
        raise ValueError(f"У этапа «{start_stage.name}» не указан участок — настройте связь в справочнике «Деталь»")
    unit = PartUnit(
        part_id=part.id,
        quantity_pieces=quantity_pieces,
        stage_id=start_stage.id,
        manufactured_at=manufactured_at if manufactured_at is not None else date.today(),
        status=PartUnitStatus.VYDAN_UCHASTKU if issue else PartUnitStatus.NA_KHRANENII,
        area=start_stage.area if issue else None,
        production_task_line_id=production_task_line_id,
        note=note,
        created_by=user_id,
    )
    db.add(unit)
    db.flush()
    record_part_event(
        db,
        unit=unit,
        event_type=PartEventType.PROIZVODSTVO,
        user_id=user_id,
        quantity_delta=quantity_pieces,
        to_stage_id=start_stage.id,
        note=note,
    )
    if issue:
        record_part_event(db, unit=unit, event_type=PartEventType.VYDACHA_UCHASTKU, user_id=user_id)
    return unit


def issue_part_unit(db: Session, *, unit: PartUnit, user_id: int) -> PartUnit:
    """Выдать участку — раздел про связь этапов с участками: участок
    выводится из `unit.stage.area`, не выбирается вручную. Если у этапа
    нет участка — явная ошибка конфигурации справочника, не место для
    ручного выбора."""
    if unit.status != PartUnitStatus.NA_KHRANENII:
        raise ValueError("Выдать участку можно только партию, которая сейчас на хранении")
    if not unit.stage.area:
        raise ValueError(f"У этапа «{unit.stage.name}» не указан участок — настройте связь в справочнике «Деталь»")
    unit.status = PartUnitStatus.VYDAN_UCHASTKU
    unit.area = unit.stage.area
    record_part_event(db, unit=unit, event_type=PartEventType.VYDACHA_UCHASTKU, user_id=user_id)
    return unit


def _split_or_reuse(db: Session, unit: PartUnit, quantity_pieces: float) -> PartUnit:
    """Партия целиком — мутируем её саму; частично — уменьшаем исходную и
    создаём новую с parent_id=unit.id на затребованное количество (тот же
    приём дробления лота, что у MaterialUnit при частичной резке/выдаче).
    Возвращает единицу, которую вызывающий код дальше переводит на новый
    этап/списывает."""
    quantity_pieces = float(quantity_pieces)
    available = float(unit.quantity_pieces)
    if quantity_pieces > available:
        raise ValueError(f"В партии только {available} шт, запрошено {quantity_pieces}")
    if quantity_pieces == available:
        return unit
    unit.quantity_pieces = available - quantity_pieces
    child = PartUnit(
        parent_id=unit.id,
        part_id=unit.part_id,
        quantity_pieces=quantity_pieces,
        stage_id=unit.stage_id,
        status=unit.status,
        area=unit.area,
        production_task_line_id=unit.production_task_line_id,
        created_by=unit.created_by,
        # Раздел про учёт п/ф по FIFO — дата изготовления переезжает с
        # родителем, не сбрасывается на "сегодня": иначе после первого же
        # частичного расхода партия теряла бы свою настоящую очередь.
        manufactured_at=unit.manufactured_at,
    )
    db.add(child)
    db.flush()
    return child


def advance_part_unit(db: Session, *, unit: PartUnit, quantity_pieces: float, user_id: int) -> tuple[PartUnit, bool]:
    """Перевод N штук партии на следующий этап её детали (раздел про
    цифровой аналог "Ежедневки" — вызывается из create_task_line_report
    при good_pieces > 0, участок сам этап не выбирает).

    Раздел про связь этапов с участками — партия физически переезжает на
    участок СЛЕДУЮЩЕГО этапа (`next_stage.area`), не остаётся числиться
    за прежним: иначе она не появилась бы в пикере "Партия п/ф" отчёта
    нового участка. Статус остаётся Выдан_участку — это тот же самый
    физический переезд, что раньше был отдельной ручной "выдачей".

    Если следующего этапа нет — партия УЖЕ на последнем этапе своего
    маршрута (обычно это финальная обработка вроде окутки) или её этап
    пропал из справочника при перенастройке — в обоих случаях это конец
    пути, не ошибка: место и этап партии не меняются, репорт просто
    фиксируется отдельным событием "Завершение", участок может отчитаться
    ещё раз по той же партии сколько угодно раз.

    Возвращает (партия, is_final) — раздел про окутку в 2 захода:
    is_final=True только когда переход именно ЗАВЕРШАЮЩИЙ (следующего
    этапа нет). Вызывающий код (create_task_line_report) использует это,
    чтобы НЕ засчитывать промежуточный проход (деталь ещё не готова
    физически) в остаток строки задания участка — см.
    ProductionTaskLineReport.counts_toward_line."""
    if unit.status != PartUnitStatus.VYDAN_UCHASTKU:
        raise ValueError("Перевести на следующий этап можно только партию, выданную участку")
    next_stage = (
        db.query(PartStage)
        .filter(PartStage.part_id == unit.part_id, PartStage.sequence_order == unit.stage.sequence_order + 1)
        .first()
    )
    if next_stage is None:
        target = _split_or_reuse(db, unit, quantity_pieces)
        record_part_event(
            db,
            unit=target,
            event_type=PartEventType.ZAVERSHENIE,
            user_id=user_id,
            quantity_delta=quantity_pieces,
            from_stage_id=target.stage_id,
        )
        return target, True
    from_stage_id = unit.stage_id
    target = _split_or_reuse(db, unit, quantity_pieces)
    target.stage_id = next_stage.id
    target.area = next_stage.area
    record_part_event(
        db,
        unit=target,
        event_type=PartEventType.PEREKHOD_ETAPA,
        user_id=user_id,
        quantity_delta=quantity_pieces,
        from_stage_id=from_stage_id,
        to_stage_id=next_stage.id,
    )
    return target, False


def consume_part_units_fifo(
    db: Session, *, part_id: int, area: str, quantity_pieces: float, user_id: int
) -> list[tuple[PartUnit, bool, float]]:
    """Оприходовать N готовых штук партий детали part_id, выданных этому
    участку — от самой старой по manufactured_at (раздел про учёт п/ф по
    FIFO: мастер больше не выбирает партию вручную для готовых деталей,
    "какую именно" решает дата изготовления, не номер). Не привязано к
    конкретному этапу партии — на одном участке могут одновременно лежать
    партии на разных этапах (например, окутка в 2 захода: "сторона 1" и
    "сторона 2" сразу) — цель FIFO именно "не давать залёживаться самому
    старому", не "все партии на одном шаге"; advance_part_unit сам
    переводит каждую партию на её СОБСТВЕННЫЙ следующий этап.

    Возвращает список (партия, is_final, взято_шт) — одна запись на
    каждую тронутую партию (обычно одна, несколько — если одной не
    хватило). Вызывающий код (create_task_line_report) создаёт свою
    строку ProductionTaskLineReport на каждую. ValueError, если по всем
    партиям суммарно не хватает — ничего не изменяется (откат снаружи).

    Раздел про "остаток" партии на последнем этапе — advance_part_unit,
    когда переводимое количество равно ВСЕЙ текущей quantity_pieces
    партии (частый случай: партию завели и в тот же день полностью
    отчитались), не уменьшает quantity_pieces и не меняет статус (тот же
    объект просто помечается событием "Завершение" — так и задумано,
    "участок может отчитаться ещё раз по той же партии", см. advance_
    part_unit) — то есть partия физически исчерпана, но выглядит как
    доступная снова, если проверять только quantity_pieces. Здесь
    остаток на партию считается за вычетом уже проведённых по НЕЙ ЖЕ
    good_pieces-отчётов (_reported_good_pieces_by_unit) — тот же приём,
    что и остаток рулона (compute_unit_consumed_length_m) — иначе
    автоматический FIFO рано или поздно повторно "нашёл" бы уже
    полностью отчитанную партию и задвоил бы её штуки."""
    candidates = (
        db.query(PartUnit)
        .filter(PartUnit.part_id == part_id, PartUnit.area == area, PartUnit.status == PartUnitStatus.VYDAN_UCHASTKU)
        .order_by(PartUnit.manufactured_at.asc(), PartUnit.id.asc())
        .all()
    )
    reported_by_unit = _reported_good_pieces_by_unit(db, [c.id for c in candidates])
    free_by_id = {c.id: float(c.quantity_pieces) - reported_by_unit.get(c.id, 0.0) for c in candidates}
    available = sum(v for v in free_by_id.values() if v > 0)
    if available < quantity_pieces:
        part_name = candidates[0].part.name if candidates else db.get(Part, part_id).name
        raise ValueError(
            f"Недостаточно партий детали «{part_name}» на участке — доступно {available} шт, нужно {quantity_pieces} шт"
        )
    results: list[tuple[PartUnit, bool, float]] = []
    remaining = quantity_pieces
    for candidate in candidates:
        if remaining <= 0:
            break
        free = free_by_id[candidate.id]
        if free <= 0:
            continue
        take = min(remaining, free)
        target, is_final = advance_part_unit(db, unit=candidate, quantity_pieces=take, user_id=user_id)
        results.append((target, is_final, take))
        remaining -= take
    return results


def _reported_good_pieces_by_unit(db: Session, unit_ids: list[int]) -> dict[int, float]:
    """Σ good_pieces уже поданных отчётов по каждой партии — раздел про
    учёт п/ф по FIFO, см. docstring consume_part_units_fifo."""
    if not unit_ids:
        return {}
    rows = (
        db.query(ProductionTaskLineReport.part_unit_id, func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
        .filter(ProductionTaskLineReport.part_unit_id.in_(unit_ids))
        .group_by(ProductionTaskLineReport.part_unit_id)
        .all()
    )
    return {row[0]: float(row[1]) for row in rows}


def write_off_part_unit(
    db: Session, *, unit: PartUnit, quantity_pieces: float, reason: str, user_id: int, note: str | None = None
) -> PartUnit:
    if unit.status == PartUnitStatus.SPISAN:
        raise ValueError("Партия уже списана")
    from_stage_id = unit.stage_id
    target = _split_or_reuse(db, unit, quantity_pieces)
    target.status = PartUnitStatus.SPISAN
    record_part_event(
        db,
        unit=target,
        event_type=PartEventType.SPISANIE,
        user_id=user_id,
        quantity_delta=-quantity_pieces,
        from_stage_id=from_stage_id,
        write_off_reason=reason,
        write_off_note=note,
        note=note,
    )
    return target
