"""Пул штрипсов плёнки на участке (FIFO-списание без сканирования конкретного рулона).

Применяется для доборного погонажа (участок «Фабрика» и аналогичные), где штрипсы
нарезаются заранее и перемещаются в цех пачками, а у станков нет начальника склада:
- Мастер отчитывается только о выпущенных деталях (good_pieces / defect_pieces).
- Система находит доступные штрипсы на участке с точным совпадением по материалу,
  цвету и ширине штрипса (strip_width_mm).
- Списание выполняется автоматически по FIFO (от самых старых штрипсов по дате поступления).
- Если длины одного штрипса не хватает, списание бесшовно переходит на следующий штрипс
  этой же ширины (предыдущий списывается в 0 со статусом SPISAN).
- Если суммарного остатка штрипсов на участке не хватает (или склад далеко и ещё не подвёз),
  отчёт мастера НЕ блокируется ошибкой 422: доступные штрипсы списываются, а остаток фиксируется
  как дефицит (минусовой остаток / перерасход) по строке задания, чтобы производство не простаивало.
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.dictionaries import MaterialSku
from app.models.events import EventType
from app.models.production import ProductionTaskLine
from app.models.units import MaterialUnit, UnitStatus
from app.services.events import record_event


@dataclass
class FilmStripAllocation:
    material_unit_id: int | None
    good_pieces: float
    defect_pieces: float
    meters: float
    is_deficit: bool = False


def get_area_matching_strips(
    db: Session,
    *,
    area: str,
    material_id: int,
    color_id: int,
    thickness_id: int | None = None,
    target_width_mm: float,
) -> list[MaterialUnit]:
    """Найти все активные штрипсы на участке, подходящие по плёнке и ширине (FIFO).
    Поддерживает точную ширину и группы эквивалентных ширин (аналогов)."""
    from app.services.width_analogs import equivalent_widths

    equiv_widths = set(equivalent_widths(db, target_width_mm))

    def _build_query(filter_thickness: bool):
        q = (
            db.query(MaterialUnit)
            .join(MaterialSku, MaterialUnit.material_sku_id == MaterialSku.id)
            .filter(
                MaterialUnit.area == area,
                MaterialUnit.status == UnitStatus.VYDAN_UCHASTKU,
                MaterialSku.material_id == material_id,
                MaterialSku.color_id == color_id,
            )
        )
        if filter_thickness and thickness_id is not None:
            q = q.filter(MaterialSku.thickness_id == thickness_id)
        if equiv_widths:
            q = q.filter(MaterialUnit.width_mm.in_(equiv_widths))
        else:
            q = q.filter(func.abs(MaterialUnit.width_mm - target_width_mm) < 0.5)
        return q.order_by(MaterialUnit.created_at.asc(), MaterialUnit.id.asc()).all()

    candidates = _build_query(filter_thickness=True)
    if not candidates and thickness_id is not None:
        candidates = _build_query(filter_thickness=False)
    return candidates


def get_strip_remaining_m(db: Session, unit: MaterialUnit) -> float:
    """Фактический остаток метров конкретного штрипса."""
    if unit.status == UnitStatus.SPISAN:
        return 0.0
    from app.api.production import _unit_consumed_length_m

    consumed = _unit_consumed_length_m(db, unit.id)
    return round(max(0.0, float(unit.length_m) - consumed), 2)


def get_area_strip_stock(
    db: Session,
    area: str,
    line: ProductionTaskLine,
) -> tuple[float, int]:
    """Суммарный доступный метраж и количество штрипсов нужной ширины на участке."""
    if line.material_id is None or line.color_id is None:
        return 0.0, 0
    from app.api.production import _line_effective_strip_width

    target_width = _line_effective_strip_width(line)
    candidates = get_area_matching_strips(
        db,
        area=area,
        material_id=line.material_id,
        color_id=line.color_id,
        thickness_id=line.thickness_id,
        target_width_mm=target_width,
    )
    total_m = 0.0
    count = 0
    for u in candidates:
        rem = get_strip_remaining_m(db, u)
        if rem > 0:
            total_m += rem
            count += 1
    return round(total_m, 2), count


def consume_film_strips_fifo(
    db: Session,
    *,
    line: ProductionTaskLine,
    area: str,
    good_pieces: float,
    defect_pieces: float,
    user_id: int,
    film_used_m: float | None = None,
) -> list[FilmStripAllocation]:
    """Списать штрипсы по FIFO под выпуск деталей.

    - Распределяет расход по подходящим штрипсам на участке по очереди.
    - Полностью израсходованный штрипс помечает SPISAN и пишет событие SPISANIE.
    - При нехватке штрипсов фиксирует остаток как дефицит (is_deficit=True, material_unit_id=None).
    """
    total_pieces = float(good_pieces) + float(defect_pieces)
    if total_pieces <= 0:
        return []

    if line.material_id is None or line.color_id is None or float(line.length_m) <= 0:
        return [
            FilmStripAllocation(
                material_unit_id=None,
                good_pieces=float(good_pieces),
                defect_pieces=float(defect_pieces),
                meters=0.0,
                is_deficit=False,
            )
        ]

    from app.api.production import _line_effective_strip_width

    length_per_piece = float(line.length_m)
    target_width = _line_effective_strip_width(line)
    candidates = get_area_matching_strips(
        db,
        area=area,
        material_id=line.material_id,
        color_id=line.color_id,
        thickness_id=line.thickness_id,
        target_width_mm=target_width,
    )

    good_left = float(good_pieces)
    defect_left = float(defect_pieces)
    allocations: list[FilmStripAllocation] = []

    for u in candidates:
        if good_left <= 0 and defect_left <= 0:
            break

        rem_m = get_strip_remaining_m(db, u)
        if rem_m <= 0.001:
            if u.status != UnitStatus.SPISAN:
                u.status = UnitStatus.SPISAN
            continue

        pieces_capacity = rem_m / length_per_piece
        pieces_needed = good_left + defect_left

        if pieces_capacity >= pieces_needed - 0.0001:
            # Штрипс полностью покрывает оставшуюся потребность
            meters = round(pieces_needed * length_per_piece, 3)
            allocations.append(
                FilmStripAllocation(
                    material_unit_id=u.id,
                    good_pieces=good_left,
                    defect_pieces=defect_left,
                    meters=meters,
                    is_deficit=False,
                )
            )
            # Если остаток штрипса меньше 5 см — закрываем его целиком
            if rem_m - meters <= 0.05:
                u.status = UnitStatus.SPISAN
                record_event(
                    db,
                    unit=u,
                    event_type=EventType.SPISANIE,
                    user_id=user_id,
                    quantity_delta_m=-float(u.length_m),
                    from_length=float(u.length_m),
                    to_length=0,
                    write_off_note=f"Расход штрипса по заданию №{line.task_id} (FIFO)",
                )
            good_left = 0.0
            defect_left = 0.0
            break
        else:
            # Штрипс покрывает только часть потребности
            take_good = min(good_left, pieces_capacity)
            good_left -= take_good
            remaining_cap = pieces_capacity - take_good
            take_defect = min(defect_left, remaining_cap)
            defect_left -= take_defect

            taken_pieces = take_good + take_defect
            meters = round(taken_pieces * length_per_piece, 3)
            allocations.append(
                FilmStripAllocation(
                    material_unit_id=u.id,
                    good_pieces=take_good,
                    defect_pieces=take_defect,
                    meters=meters,
                    is_deficit=False,
                )
            )
            # Штрипс израсходован до конца
            u.status = UnitStatus.SPISAN
            record_event(
                db,
                unit=u,
                event_type=EventType.SPISANIE,
                user_id=user_id,
                quantity_delta_m=-float(u.length_m),
                from_length=float(u.length_m),
                to_length=0,
                write_off_note=f"Расход штрипса по заданию №{line.task_id} (FIFO)",
            )

    # Нехватка штрипсов на участке фиксируется как дефицит
    if good_left > 0 or defect_left > 0:
        deficit_pieces = good_left + defect_left
        deficit_m = round(deficit_pieces * length_per_piece, 3)
        allocations.append(
            FilmStripAllocation(
                material_unit_id=None,
                good_pieces=good_left,
                defect_pieces=defect_left,
                meters=deficit_m,
                is_deficit=True,
            )
        )

    return allocations

def adjust_strip_pool_stock(
    db: Session,
    *,
    area: str,
    material_id: int,
    color_id: int,
    thickness_id: int | None = None,
    target_width_mm: float,
    actual_meters: float,
    user_id: int,
    note: str | None = None,
) -> dict:
    """Локальная экспресс-инвентаризация пула штрипсов на участке.

    Сверяет учётный остаток с физическим фактическим:
    - При недостаче (actual < current): списывает разницу по FIFO (EventType.INVENTARIZATSIYA_NEDOSTACHA / SPISANIE).
    - При излишке (actual > current): приходует новую партию штрипса на участок (EventType.INVENTARIZATSIYA_IZLISHEK).
    """
    actual_meters = max(0.0, round(float(actual_meters), 2))
    active_strips = get_area_matching_strips(
        db,
        area=area,
        material_id=material_id,
        color_id=color_id,
        thickness_id=thickness_id,
        target_width_mm=target_width_mm,
    )
    current_meters = round(sum(get_strip_remaining_m(db, u) for u in active_strips), 2)
    delta = round(actual_meters - current_meters, 2)

    if abs(delta) < 0.01:
        return {
            "ok": True,
            "area": area,
            "target_width_mm": target_width_mm,
            "previous_meters": current_meters,
            "actual_meters": actual_meters,
            "delta_meters": 0.0,
            "active_units_count": len(active_strips),
        }

    if delta < 0:
        # Недостача: списываем по FIFO
        to_deduct = abs(delta)
        for u in active_strips:
            rem = get_strip_remaining_m(db, u)
            if rem <= 0:
                continue
            deduct_this = min(to_deduct, rem)
            if rem - deduct_this <= 0.05:
                u.status = UnitStatus.SPISAN
                record_event(
                    db,
                    unit=u,
                    event_type=EventType.INVENTARIZATSIYA_NEDOSTACHA,
                    user_id=user_id,
                    quantity_delta_m=-rem,
                    from_length=float(u.length_m),
                    to_length=0,
                    write_off_note=note or f"Экспресс-инвентаризация пула ({area}): списание недостачи {abs(delta)} м",
                )
            else:
                old_len = float(u.length_m)
                u.length_m = round(old_len - deduct_this, 2)
                record_event(
                    db,
                    unit=u,
                    event_type=EventType.INVENTARIZATSIYA_NEDOSTACHA,
                    user_id=user_id,
                    quantity_delta_m=-deduct_this,
                    from_length=old_len,
                    to_length=float(u.length_m),
                    write_off_note=note or f"Экспресс-инвентаризация пула ({area}): уменьшение остатка на {deduct_this} м",
                )
            to_deduct = round(to_deduct - deduct_this, 2)
            if to_deduct <= 0:
                break
    else:
        # Излишек: создаём единицу штрипса на участке
        sku_q = db.query(MaterialSku).filter(
            MaterialSku.material_id == material_id,
            MaterialSku.color_id == color_id,
        )
        if thickness_id is not None:
            sku = sku_q.filter(MaterialSku.thickness_id == thickness_id).first()
        else:
            sku = sku_q.first()
        if sku is None:
            sku = sku_q.first()
        if sku is None:
            raise ValueError(f"SKU для material_id={material_id}, color_id={color_id} не найден")

        from datetime import date
        today_str = date.today().strftime("%d.%m")
        new_unit = MaterialUnit(
            material_sku_id=sku.id,
            status=UnitStatus.VYDAN_UCHASTKU,
            area=area,
            is_strip=True,
            width_mm=target_width_mm,
            length_m=delta,
            upd_number=f"ИНВ-{area.upper()}-{today_str}",
            pallet_number=f"ПУЛ-{int(target_width_mm)}",
        )
        db.add(new_unit)
        db.flush()
        record_event(
            db,
            unit=new_unit,
            event_type=EventType.INVENTARIZATSIYA_IZLISHEK,
            user_id=user_id,
            quantity_delta_m=delta,
            to_length=delta,
            write_off_note=note or f"Экспресс-инвентаризация пула ({area}): оприходование излишка +{delta} м",
        )

    db.flush()

    if actual_meters > 0:
        # Покрываем ранее зафиксированный дефицит в отчётах по активным заданиям участка
        from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
        from app.services.width_analogs import equivalent_widths
        equiv_ws = equivalent_widths(db, target_width_mm)
        donor_unit = new_unit if delta > 0 else (active_strips[0] if active_strips else None)
        if donor_unit:
            deficit_reports = (
                db.query(ProductionTaskLineReport)
                .join(ProductionTaskLine, ProductionTaskLineReport.task_line_id == ProductionTaskLine.id)
                .join(ProductionTask, ProductionTaskLine.task_id == ProductionTask.id)
                .filter(
                    ProductionTask.area == area,
                    ProductionTask.is_active.is_(True),
                    ProductionTaskLine.material_id == material_id,
                    ProductionTaskLine.color_id == color_id,
                    ProductionTaskLine.strip_width_mm.in_(equiv_ws),
                    ProductionTaskLineReport.material_unit_id.is_(None),
                    ProductionTaskLineReport.note.ilike("%Дефицит плёнки:%"),
                    ProductionTaskLineReport.counts_toward_line.is_(True),
                )
                .all()
            )
            for rep in deficit_reports:
                rep.material_unit_id = donor_unit.id
                rep_note = rep.note or ""
                suffix = f" [Покрыто сверкой пула: юнит #{donor_unit.id}]"
                if suffix not in rep_note:
                    rep.note = (rep_note + suffix).strip()
            db.flush()

    active_now = get_area_matching_strips(
        db,
        area=area,
        material_id=material_id,
        color_id=color_id,
        thickness_id=thickness_id,
        target_width_mm=target_width_mm,
    )
    new_actual = round(sum(get_strip_remaining_m(db, u) for u in active_now), 2)
    return {
        "ok": True,
        "area": area,
        "target_width_mm": target_width_mm,
        "previous_meters": current_meters,
        "actual_meters": new_actual,
        "delta_meters": delta,
        "active_units_count": len(active_now),
    }

