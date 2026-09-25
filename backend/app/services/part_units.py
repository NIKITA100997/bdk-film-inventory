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
    related_part_unit_id: int | None = None,
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
        related_part_unit_id=related_part_unit_id,
        **({"occurred_at": occurred_at} if occurred_at is not None else {}),
    )
    db.add(event)
    return event


def place_part_unit(
    db: Session, *, unit: PartUnit, location_code: str, user_id: int, occurred_at: datetime | None = None
) -> PartUnit:
    """Разместить партию на полку стеллажа п/ф (раздел про адресное
    хранение). В отличие от плёнки (склад/участок всегда разные физические
    места, `place_unit`/MaterialUnit держат их взаимоисключающими) —
    у п/ф на последнем этапе (окутка и т.п.) участок И ЕСТЬ склад: партия
    хранится прямо на участке (запас, из которого мастер расходует по
    отчётам) и одновременно должна быть видна на карте стеллажей. Поэтому
    `area`+`location_code` у п/ф намеренно совместимы; запрещено только
    для уже списанной партии (SPISAN) — размещать больше нечего."""
    if unit.status == PartUnitStatus.SPISAN:
        raise ValueError("Партия уже списана — разместить нечего")
    from_cell = unit.location_code
    unit.location_code = location_code
    record_part_event(
        db,
        unit=unit,
        event_type=PartEventType.RAZMESHCHENIE,
        user_id=user_id,
        from_cell=from_cell,
        to_cell=location_code,
        occurred_at=occurred_at,
    )
    return unit


def mint_part_unit(
    db: Session,
    *,
    part: Part,
    quantity_pieces: float,
    user_id: int,
    production_task_line_id: int | None = None,
    note: str | None = None,
    stage_id: int | None = None,
    manufactured_at: date | None = None,
    film_restriction: str | None = None,
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

    Раздел про "зачем кнопка выдать участку, если физически деталь уже
    на участке" — партия считается выданной участку АВТОМАТИЧЕСКИ, если
    у стартового этапа настроен участок (обычно так и есть — см. докстринг
    place_part_unit: участок и есть физическое место, где деталь реально
    лежит с момента изготовления, отдельного шага "выдать" для этого не
    нужно). Явного выбора "на хранении / выдано" больше нет — статус
    целиком выводится из наличия участка у этапа; отдельного пути
    "зарегистрировать, но не выдавать" сознательно нет (см. issue_part_
    unit/эндпоинт /issue — удалены за ненадобностью)."""
    if not part.stages:
        raise ValueError(f"У детали «{part.name}» не настроены этапы — добавьте их в справочнике «Деталь»")
    if stage_id is not None:
        start_stage = next((s for s in part.stages if s.id == stage_id), None)
        if start_stage is None:
            raise ValueError(f"Этап не найден среди этапов детали «{part.name}»")
    else:
        start_stage = part.stages[0]
    issued = bool(start_stage.area)
    unit = PartUnit(
        part_id=part.id,
        quantity_pieces=quantity_pieces,
        stage_id=start_stage.id,
        manufactured_at=manufactured_at if manufactured_at is not None else date.today(),
        status=PartUnitStatus.VYDAN_UCHASTKU if issued else PartUnitStatus.NA_KHRANENII,
        area=start_stage.area,
        production_task_line_id=production_task_line_id,
        note=note,
        film_restriction=film_restriction,
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
    if issued:
        # Раздел про ревизию путей п/ф — quantity_delta здесь раньше
        # молча оставался 0 (значение по умолчанию), в отличие от
        # зеркального MaterialEvent.VYDACHA_UCHASTKU у плёнки, который
        # всегда несёт -length. Любой будущий отчёт "выпуск/расход",
        # считающий по сумме событий, получил бы для п/ф ноль вместо
        # реальной выданной величины.
        record_part_event(
            db, unit=unit, event_type=PartEventType.VYDACHA_UCHASTKU, user_id=user_id,
            quantity_delta=quantity_pieces,
        )
    return unit


def issue_part_unit(
    db: Session, *, unit: PartUnit, user_id: int, quantity_pieces: float | None = None,
    occurred_at: datetime | None = None,
) -> PartUnit:
    """«Передать на участок» (25.09): партия «На хранении» (например,
    возвращённая на склад) уходит на участок своего этапа и становится
    доступна его отчётам. Часть партии — отделяется новой партией. С полки
    стеллажа партия при этом снимается."""
    if unit.status != PartUnitStatus.NA_KHRANENII:
        raise ValueError("Передать на участок можно только партию «На хранении»")
    area = unit.stage.area if unit.stage else None
    if not area:
        raise ValueError(f"У этапа «{unit.stage.name}» не указан участок — передавать некуда")
    qty = float(unit.quantity_pieces) if quantity_pieces is None else quantity_pieces
    if qty > float(unit.quantity_pieces) + 1e-9:
        raise ValueError(f"В партии {float(unit.quantity_pieces):g} шт — передать {qty:g} нельзя")
    target = _split_or_reuse(db, unit, qty)
    from_cell = target.location_code
    target.status = PartUnitStatus.VYDAN_UCHASTKU
    target.area = area
    target.location_code = None
    record_part_event(
        db, unit=target, event_type=PartEventType.VYDACHA_UCHASTKU, user_id=user_id, quantity_delta=qty,
        from_cell=from_cell, occurred_at=occurred_at,
    )
    return target


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


def advance_part_unit(
    db: Session, *, unit: PartUnit, quantity_pieces: float, user_id: int, occurred_at: datetime | None = None
) -> tuple[PartUnit, bool]:
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
            occurred_at=occurred_at,
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
        occurred_at=occurred_at,
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
    good_pieces-отчётов (reported_good_pieces_by_unit) — тот же приём,
    что и остаток рулона (compute_unit_consumed_length_m) — иначе
    автоматический FIFO рано или поздно повторно "нашёл" бы уже
    полностью отчитанную партию и задвоил бы её штуки."""
    candidates = (
        db.query(PartUnit)
        .filter(PartUnit.part_id == part_id, PartUnit.area == area, PartUnit.status == PartUnitStatus.VYDAN_UCHASTKU)
        .order_by(PartUnit.manufactured_at.asc(), PartUnit.id.asc())
        .all()
    )
    reported_by_unit = reported_good_pieces_by_unit(db, [c.id for c in candidates])
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


def consume_defect_fifo(
    db: Session, *, part_id: int, area: str, quantity_pieces: float, user_id: int, reason: str, note: str | None = None
) -> list[tuple[PartUnit, float]]:
    """Списать N бракованных штук партий детали part_id, выданных этому
    участку — от самой старой по manufactured_at, тот же принцип FIFO, что
    и у consume_part_units_fifo для готовых деталей (раздел про ревизию
    путей п/ф: раньше партию для брака выбирали вручную — деталь физически
    на участке одна, выбор был лишним шагом, а без него брак вообще не
    списывался с п/ф). Та же поправка на "уже отчитанное"
    (reported_good_pieces_by_unit), что у consume_part_units_fifo — партия,
    уже полностью взятая в good_pieces (но не разделившаяся физически, см.
    docstring там), не должна выглядеть доступной для списания брака.

    В отличие от consume_part_units_fifo, write_off_part_unit сам переводит
    затронутую партию в статус Списан — уже списанная партия сама выпадает
    из кандидатов на следующий раз, никакой отдельной поправки на "уже
    списанное" не нужно.

    Возвращает список (партия, взято_шт) — одна запись на каждую
    затронутую партию. ValueError, если суммарно не хватает — ничего не
    меняется (откат снаружи)."""
    candidates = (
        db.query(PartUnit)
        .filter(PartUnit.part_id == part_id, PartUnit.area == area, PartUnit.status == PartUnitStatus.VYDAN_UCHASTKU)
        .order_by(PartUnit.manufactured_at.asc(), PartUnit.id.asc())
        .all()
    )
    reported_by_unit = reported_good_pieces_by_unit(db, [c.id for c in candidates])
    free_by_id = {c.id: float(c.quantity_pieces) - reported_by_unit.get(c.id, 0.0) for c in candidates}
    available = sum(v for v in free_by_id.values() if v > 0)
    if available < quantity_pieces:
        part_name = candidates[0].part.name if candidates else db.get(Part, part_id).name
        raise ValueError(
            f"Недостаточно партий детали «{part_name}» на участке для списания брака — доступно {available} шт, нужно {quantity_pieces} шт"
        )
    results: list[tuple[PartUnit, float]] = []
    remaining = quantity_pieces
    for candidate in candidates:
        if remaining <= 0:
            break
        free = free_by_id[candidate.id]
        if free <= 0:
            continue
        take = min(remaining, free)
        write_off_part_unit(db, unit=candidate, quantity_pieces=take, reason=reason, user_id=user_id, note=note)
        results.append((candidate, take))
        remaining -= take
    return results


def reserve_part_unit_for_recycle(
    db: Session, *, unit: PartUnit, quantity_pieces: float, reason: str, user_id: int, note: str | None = None
) -> PartUnit:
    """Зарезервировать N штук партии под переработку в другую деталь —
    раздел про переработку брака: та же механика дробления, что у
    write_off_part_unit, но новый статус V_PERERABOTKU (резерв, партия
    физически остаётся на месте — обычно на окутке), не SPISAN
    (окончательная потеря). Забрать резерв в готовую деталь — отдельное
    действие recycle_part_units_fifo ниже."""
    if unit.status == PartUnitStatus.SPISAN:
        raise ValueError("Партия уже списана")
    from_stage_id = unit.stage_id
    target = _split_or_reuse(db, unit, quantity_pieces)
    target.status = PartUnitStatus.V_PERERABOTKU
    record_part_event(
        db,
        unit=target,
        event_type=PartEventType.V_PERERABOTKU,
        user_id=user_id,
        quantity_delta=-quantity_pieces,
        from_stage_id=from_stage_id,
        write_off_reason=reason,
        write_off_note=note,
        note=note,
    )
    return target


def reserve_defect_for_recycle_fifo(
    db: Session, *, part_id: int, area: str, quantity_pieces: float, user_id: int, reason: str, note: str | None = None
) -> list[tuple[PartUnit, float]]:
    """Зарезервировать N бракованных штук партий детали part_id под
    переработку — альтернатива consume_defect_fifo для случая "В
    переработку" вместо "Списать насовсем" (раздел про переработку
    брака): тот же FIFO по manufactured_at и та же поправка на уже
    отчитанное (reported_good_pieces_by_unit), только вместо
    write_off_part_unit — reserve_part_unit_for_recycle (статус
    V_PERERABOTKU, не SPISAN)."""
    candidates = (
        db.query(PartUnit)
        .filter(PartUnit.part_id == part_id, PartUnit.area == area, PartUnit.status == PartUnitStatus.VYDAN_UCHASTKU)
        .order_by(PartUnit.manufactured_at.asc(), PartUnit.id.asc())
        .all()
    )
    reported_by_unit = reported_good_pieces_by_unit(db, [c.id for c in candidates])
    free_by_id = {c.id: float(c.quantity_pieces) - reported_by_unit.get(c.id, 0.0) for c in candidates}
    available = sum(v for v in free_by_id.values() if v > 0)
    if available < quantity_pieces:
        part_name = candidates[0].part.name if candidates else db.get(Part, part_id).name
        raise ValueError(
            f"Недостаточно партий детали «{part_name}» на участке для переработки — доступно {available} шт, нужно {quantity_pieces} шт"
        )
    results: list[tuple[PartUnit, float]] = []
    remaining = quantity_pieces
    for candidate in candidates:
        if remaining <= 0:
            break
        free = free_by_id[candidate.id]
        if free <= 0:
            continue
        take = min(remaining, free)
        reserved = reserve_part_unit_for_recycle(db, unit=candidate, quantity_pieces=take, reason=reason, user_id=user_id, note=note)
        results.append((reserved, take))
        remaining -= take
    return results


def recycle_part_units_fifo(
    db: Session,
    *,
    source_part_id: int,
    area: str,
    quantity_pieces: float,
    target_part_id: int,
    user_id: int,
    note: str | None = None,
) -> PartUnit:
    """"Переработать в деталь" — действие про переработку брака: забрать
    резерв (V_PERERABOTKU) детали source_part_id по FIFO и заминтить
    новую партию ДРУГОЙ детали (target_part_id) сразу на её этапе
    «Окутка» (пользователь подтвердил: материал физически остаётся на
    окутке и сразу пускается в неё же, минуя склейку/фрезеровку) —
    новая партия рождается сразу Выдан_участку на участке этого этапа,
    готовая к работе, как любая другая партия на окутке.

    Резерв никогда не участвует в good/defect-отчётах (в отличие от
    обычного Выдан_участку), поэтому поправка на "уже отчитанное" здесь
    не нужна — доступно ровно quantity_pieces партий-источников.

    Каждая затронутая партия-источник переходит в Списан (материал в
    этой форме исчерпан) с событием "Переработка" (quantity_delta
    отрицательный, related_part_unit_id → новая партия) — обратная
    ссылка на источники видна в note новой партии текстом (номера +
    количество), не отдельным полем: одна партия может родиться сразу
    из нескольких источников."""
    if source_part_id == target_part_id:
        raise ValueError("Переработка в ту же деталь не имеет смысла")
    target_part = db.get(Part, target_part_id)
    if target_part is None:
        raise ValueError("Целевая деталь не найдена")
    okutka_stage = next((s for s in target_part.stages if s.name == "Окутка"), None)
    if okutka_stage is None:
        raise ValueError(f"У детали «{target_part.name}» нет этапа «Окутка» — переработка в неё недоступна")
    if not okutka_stage.area:
        raise ValueError(f"У этапа «Окутка» детали «{target_part.name}» не указан участок — настройте в справочнике «Деталь»")

    candidates = (
        db.query(PartUnit)
        .filter(PartUnit.part_id == source_part_id, PartUnit.area == area, PartUnit.status == PartUnitStatus.V_PERERABOTKU)
        .order_by(PartUnit.manufactured_at.asc(), PartUnit.id.asc())
        .all()
    )
    available = sum(float(c.quantity_pieces) for c in candidates)
    if available < quantity_pieces:
        part_name = candidates[0].part.name if candidates else db.get(Part, source_part_id).name
        raise ValueError(
            f"Недостаточно резерва в переработке детали «{part_name}» — доступно {available} шт, нужно {quantity_pieces} шт"
        )

    new_unit = PartUnit(
        part_id=target_part.id,
        quantity_pieces=quantity_pieces,
        stage_id=okutka_stage.id,
        manufactured_at=date.today(),
        status=PartUnitStatus.VYDAN_UCHASTKU,
        area=okutka_stage.area,
        note=note,
        created_by=user_id,
    )
    db.add(new_unit)
    db.flush()

    remaining = quantity_pieces
    source_labels: list[str] = []
    for candidate in candidates:
        if remaining <= 0:
            break
        take = min(remaining, float(candidate.quantity_pieces))
        target = _split_or_reuse(db, candidate, take)
        target.status = PartUnitStatus.SPISAN
        record_part_event(
            db,
            unit=target,
            event_type=PartEventType.PERERABOTKA,
            user_id=user_id,
            quantity_delta=-take,
            related_part_unit_id=new_unit.id,
            note=note,
        )
        source_labels.append(f"№{target.id} ({take} шт)")
        remaining -= take

    source_note = f"Из резерва переработки: {', '.join(source_labels)}"
    record_part_event(
        db,
        unit=new_unit,
        event_type=PartEventType.PERERABOTKA,
        user_id=user_id,
        quantity_delta=quantity_pieces,
        to_stage_id=okutka_stage.id,
        note=f"{note} — {source_note}" if note else source_note,
    )
    return new_unit


def reported_good_pieces_by_unit(db: Session, unit_ids: list[int]) -> dict[int, float]:
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
    db: Session,
    *,
    unit: PartUnit,
    quantity_pieces: float,
    reason: str,
    user_id: int,
    note: str | None = None,
    occurred_at: datetime | None = None,
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
        occurred_at=occurred_at,
    )
    return target


def return_part_unit(
    db: Session, *, unit: PartUnit, actual_quantity_pieces: float, user_id: int, occurred_at: datetime | None = None
) -> PartUnit:
    """Вернуть партию на склад п/ф, не использовав (или использовав лишь
    частично) — раздел про ревизию путей п/ф: зеркалит `return_unit` у
    плёнки (api/units.py). Статус → На_хранении, area очищается; этап
    (`stage_id`) и место в маршруте НЕ откатываются — партия просто
    физически вернулась, её прогресс по этапам это не отменяет (в
    отличие от advance_part_unit, который двигает её вперёд).

    `actual_quantity_pieces` — сколько реально возвращается (как
    `actual_length_m` у плёнки): может быть меньше `quantity_pieces`,
    если часть физически ушла в дело без отдельного отчёта — разница
    просто фиксируется событием, как есть, без попытки досчитать расход
    (в отличие от `return_unit`, у которого для этого есть отдельная
    привязка к строке задания через ProductionTaskLineReport).

    Верхняя граница — не сырое `quantity_pieces`, а доступное за
    вычетом уже отчитанного (`reported_good_pieces_by_unit`, тот же
    приём, что и в consume_part_units_fifo): партия на последнем этапе,
    уже полностью взятая в отчёт, не уменьшает quantity_pieces (см.
    advance_part_unit) и выглядела бы "доступной" для возврата снова,
    хотя физически возвращать уже нечего."""
    if unit.status != PartUnitStatus.VYDAN_UCHASTKU:
        raise ValueError("Вернуть на склад можно только партию, выданную участку")
    old_quantity = float(unit.quantity_pieces)
    reported = reported_good_pieces_by_unit(db, [unit.id]).get(unit.id, 0.0)
    available = max(0.0, old_quantity - reported)
    if actual_quantity_pieces > available:
        raise ValueError(f"Доступно к возврату {available} шт — вернуть больше нельзя")
    unit.quantity_pieces = actual_quantity_pieces
    unit.status = PartUnitStatus.NA_KHRANENII
    unit.area = None
    record_part_event(
        db,
        unit=unit,
        event_type=PartEventType.VOZVRAT,
        user_id=user_id,
        quantity_delta=actual_quantity_pieces - old_quantity,
        occurred_at=occurred_at,
    )
    return unit


def settle_excess_part_unit_at_area(
    db: Session, *, unit: PartUnit, user_id: int, occurred_at: datetime | None = None
) -> PartUnit:
    """Излишек сверх плана строки задания на финальном этапе (окутка и
    т.п.) — раздел про списание готовых п/ф по плану строки задания (см.
    _build_task_line_report): становится обычным доступным остатком
    (На_хранении), но, В ОТЛИЧИЕ от return_part_unit, `area` НЕ
    очищается — для п/ф на последнем этапе участок И ЕСТЬ склад (см.
    докстринг place_part_unit), а не площадка, с которой физически
    возвращаются на настоящий склад. Очистка area здесь сделала бы
    остаток невидимым в разбивке "по участкам" (Остатки п/ф) именно там,
    где он физически лежит."""
    if unit.status != PartUnitStatus.VYDAN_UCHASTKU:
        raise ValueError("Перевести в остаток можно только партию, выданную участку")
    unit.status = PartUnitStatus.NA_KHRANENII
    record_part_event(
        db,
        unit=unit,
        event_type=PartEventType.VOZVRAT,
        user_id=user_id,
        quantity_delta=0,
        occurred_at=occurred_at,
    )
    return unit


def adjust_part_unit(
    db: Session,
    *,
    unit: PartUnit,
    actual_quantity_pieces: float,
    reason: str,
    user_id: int,
    note: str | None = None,
    film_restriction: str | None = None,
    clear_film_restriction: bool = False,
    occurred_at: datetime | None = None,
) -> PartUnit:
    """Формальная корректировка quantity_pieces — раздел про ревизию
    путей плёнки/п/ф: вместо правки истории напрямую в БД (так в этой же
    сессии чинили штрипсы 2115/2324/партии строки «Багет Б-2/М» —
    scp-скрипт, ручной UPDATE, удаление на проде вручную) — поднадзорное
    действие, которое ВСЕГДА добавляет событие, никогда не переписывает
    и не удаляет прошлое. Не завязана на статус — корректировать можно и
    На_хранении, и Выдан_участку, причина обязательна (для аудита, кто и
    почему поправил цифру).

    film_restriction/clear_film_restriction — раздел про совместимость с
    плёнкой: пометку на партии ("ламис"/"с кромкой" и т.п.) можно
    проставить или снять заодно с корректировкой количества, тем же
    событием — clear_film_restriction нужен отдельным флагом, иначе
    "не передали поле" и "явно снять пометку" неразличимы (None в обоих
    случаях)."""
    old_quantity = float(unit.quantity_pieces)
    unit.quantity_pieces = actual_quantity_pieces
    restriction_note = ""
    if clear_film_restriction and unit.film_restriction is not None:
        restriction_note = " (пометка плёнки снята)"
        unit.film_restriction = None
    elif film_restriction is not None and film_restriction != unit.film_restriction:
        restriction_note = f" (пометка плёнки: {film_restriction})"
        unit.film_restriction = film_restriction
    record_part_event(
        db,
        unit=unit,
        event_type=PartEventType.KORREKTIROVKA,
        user_id=user_id,
        quantity_delta=actual_quantity_pieces - old_quantity,
        note=(reason if not note else f"{reason} — {note}") + restriction_note,
        occurred_at=occurred_at,
    )
    return unit
