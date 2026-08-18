"""Правило маркировки при разделении единицы плёнки (разделы 2.3–2.4 ТЗ).

Чистые функции без обращения к БД/сессии: принимают текущее состояние
единицы и параметры операции, возвращают, что нужно записать. Персистенция
(создание строк, коммит) — в API/сервисном слое, использующем эти функции;
здесь — только сама бизнес-логика, чтобы её можно было проверить в pytest
без поднятой БД.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models.events import EventType
from app.models.units import MaterialUnit, UnitStatus


@dataclass
class NewUnitSpec:
    """Данные для создания новой единицы (INSERT выполняет вызывающий код)."""

    parent_id: int
    upd_number: str
    pallet_number: str
    material_sku_id: int
    width_mm: float
    length_m: float
    status: UnitStatus
    location_code: str | None = None


@dataclass
class EventSpec:
    """Данные для строки MaterialEvent. unit_id=None означает "у ещё не
    вставленной новой единицы" — вызывающий код подставляет id после INSERT.
    """

    unit_id: int | None
    material_sku_id: int
    event_type: EventType
    width_mm: float
    from_length: float | None = None
    to_length: float | None = None
    from_cell: str | None = None
    to_cell: str | None = None
    quantity_delta_m: float = 0


@dataclass
class SplitOutcome:
    parent_width_mm: float
    parent_length_m: float
    parent_status: UnitStatus
    new_unit: NewUnitSpec | None
    parent_event: EventSpec
    new_unit_event: EventSpec | None


def split_lengthwise(unit: MaterialUnit, separate_width_mm: float, *, new_unit_location: str | None = None) -> SplitOutcome:
    """Продольная резка (по ширине), всегда на складе плёнки (2.4 ТЗ).

    Длина у обеих результирующих частей одинаковая, меняется только ширина.
    Часть, что остаётся "продолжением", сохраняет тот же ID и ту же бирку —
    в БД просто обновляется width_mm. Отделяемая часть (штрипс-остаток)
    становится новой единицей с parent_id исходной (правило 2.3).
    """

    width_mm = float(unit.width_mm)
    if separate_width_mm <= 0:
        raise ValueError("Ширина отделяемой части должна быть больше нуля")
    if separate_width_mm >= width_mm:
        raise ValueError("Ширина отделяемой части должна быть меньше текущей ширины единицы")

    remaining_width_mm = width_mm - separate_width_mm
    length_m = float(unit.length_m)

    new_unit = NewUnitSpec(
        parent_id=unit.id,
        upd_number=unit.upd_number,
        pallet_number=unit.pallet_number,
        material_sku_id=unit.material_sku_id,
        width_mm=separate_width_mm,
        length_m=length_m,
        status=UnitStatus.NA_KHRANENII,
        location_code=new_unit_location,
    )

    parent_event = EventSpec(
        unit_id=unit.id,
        material_sku_id=unit.material_sku_id,
        event_type=EventType.PRODOLNAYA_REZKA,
        width_mm=remaining_width_mm,
        from_length=length_m,
        to_length=length_m,
        quantity_delta_m=0,
    )
    new_unit_event = EventSpec(
        unit_id=None,
        material_sku_id=unit.material_sku_id,
        event_type=EventType.PRODOLNAYA_REZKA,
        width_mm=separate_width_mm,
        to_length=length_m,
        to_cell=new_unit_location,
        quantity_delta_m=length_m,
    )

    return SplitOutcome(
        parent_width_mm=remaining_width_mm,
        parent_length_m=length_m,
        parent_status=unit.status,
        new_unit=new_unit,
        parent_event=parent_event,
        new_unit_event=new_unit_event,
    )


@dataclass
class MultiSplitOutcome:
    parent_width_mm: float
    parent_length_m: float
    parent_status: UnitStatus
    new_units: list[NewUnitSpec]
    parent_event: EventSpec
    new_unit_events: list[EventSpec]


def split_lengthwise_multi(unit: MaterialUnit, cut_widths_mm: list[float]) -> MultiSplitOutcome:
    """Несколько кусков одинаковой длины из одного донора за один проход
    щелевой резки (раздел про план резки на несколько ширин за раз) — тот
    же принцип, что split_lengthwise, но на N кусков сразу вместо одного:
    родитель отдаёт часть ширины каждому куску, длина общая для всех
    (резка вдоль её не меняет). Остаток (donor_width - sum(cut_widths_mm))
    остаётся на родителе — списание слишком узкого остатка в отход
    (CalcSettings.min_useful_width_mm) — забота вызывающего кода
    (api/units.py), как и у split_lengthwise (та же проверка не входит в
    эту чистую функцию)."""

    width_mm = float(unit.width_mm)
    if not cut_widths_mm:
        raise ValueError("Нужна хотя бы одна ширина для резки")
    if any(w <= 0 for w in cut_widths_mm):
        raise ValueError("Ширина каждого куска должна быть больше нуля")
    total_cut_width_mm = sum(cut_widths_mm)
    if total_cut_width_mm > width_mm:
        raise ValueError("Сумма ширин кусков больше ширины донора")

    remaining_width_mm = width_mm - total_cut_width_mm
    length_m = float(unit.length_m)

    new_units = [
        NewUnitSpec(
            parent_id=unit.id,
            upd_number=unit.upd_number,
            pallet_number=unit.pallet_number,
            material_sku_id=unit.material_sku_id,
            width_mm=w,
            length_m=length_m,
            status=UnitStatus.NA_KHRANENII,
        )
        for w in cut_widths_mm
    ]

    parent_event = EventSpec(
        unit_id=unit.id,
        material_sku_id=unit.material_sku_id,
        event_type=EventType.PRODOLNAYA_REZKA,
        width_mm=remaining_width_mm,
        from_length=length_m,
        to_length=length_m,
        quantity_delta_m=0,
    )
    new_unit_events = [
        EventSpec(
            unit_id=None,
            material_sku_id=unit.material_sku_id,
            event_type=EventType.PRODOLNAYA_REZKA,
            width_mm=w,
            to_length=length_m,
            quantity_delta_m=length_m,
        )
        for w in cut_widths_mm
    ]

    return MultiSplitOutcome(
        parent_width_mm=remaining_width_mm,
        parent_length_m=length_m,
        parent_status=unit.status,
        new_units=new_units,
        parent_event=parent_event,
        new_unit_events=new_unit_events,
    )


def cut_to_length(unit: MaterialUnit, cut_length_m: float, *, remainder_location: str | None = None) -> SplitOutcome:
    """Раскрой (по длине) — физически возможен только там, где деталь
    требует дискретного куска точного размера: на складе при совмещённой
    резке под цельнолистовые, либо на участке цельнолистовых на стеллаже Б
    (2.4 ТЗ). Отрезанный кусок точного размера уходит в производство сразу
    (списывается, новая единица не создаётся) — остаток по длине продолжает
    жить под тем же ID.
    """

    length_m = float(unit.length_m)
    if cut_length_m <= 0:
        raise ValueError("Длина раскроя должна быть больше нуля")
    if cut_length_m > length_m:
        raise ValueError("Недостаточно длины в единице для такого раскроя")

    remaining_length_m = length_m - cut_length_m
    width_mm = float(unit.width_mm)

    parent_event = EventSpec(
        unit_id=unit.id,
        material_sku_id=unit.material_sku_id,
        event_type=EventType.RASKROY,
        width_mm=width_mm,
        from_length=length_m,
        to_length=remaining_length_m,
        to_cell=remainder_location,
        quantity_delta_m=-cut_length_m,
    )

    parent_status = UnitStatus.SPISAN if remaining_length_m == 0 else unit.status

    return SplitOutcome(
        parent_width_mm=width_mm,
        parent_length_m=remaining_length_m,
        parent_status=parent_status,
        new_unit=None,
        parent_event=parent_event,
        new_unit_event=None,
    )
