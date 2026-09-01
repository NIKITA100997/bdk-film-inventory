from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field

from app.models.events import EventType
from app.models.units import UnitStatus
from app.schemas.common import OccurredAt
from app.schemas.dictionaries import MaterialSkuOut


class ReceiveRequest(BaseModel):
    upd_number: str
    pallet_number: str
    material: str
    color: str
    thickness: float
    manufacturer: str
    width_mm: float = Field(gt=0)
    length_m: float = Field(gt=0)
    quantity: int = Field(gt=0, le=200)
    location_code: str | None = None
    is_strip: bool = False
    occurred_at: OccurredAt = None


class MaterialUnitOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    parent_id: int | None
    upd_number: str
    pallet_number: str
    material_sku: MaterialSkuOut
    width_mm: float
    length_m: float
    is_strip: bool
    status: UnitStatus
    area: str | None
    location_code: str | None
    production_task_line_id: int | None
    created_at: datetime
    updated_at: datetime
    # Раздел про остатки по конкретному складу — не прямое поле в БД (см.
    # search_units в api/units.py), заполняется только там, где реально
    # разрешается; в остальных ответах остаётся None.
    warehouse_name: str | None = None

    @computed_field
    @property
    def area_m2(self) -> float:
        return round(float(self.width_mm) * float(self.length_m) / 1000, 3)


class WriteOffRequest(BaseModel):
    """reason — code причины из write_off_reasons (раздел про
    администрирование причин). Системные причины (is_system=True,
    например "Отход при раскрое" — выставляется только автоматически
    при раскрое, split_unit) вручную через это тело недоступны, проверка
    в api/units.py::write_off (нужен доступ к БД, не делается на уровне
    схемы)."""

    reason: str
    note: str | None = None
    occurred_at: OccurredAt = None


class PlaceRequest(BaseModel):
    location_code: str
    occurred_at: OccurredAt = None


class ReassignSkuRequest(BaseModel):
    """Исправление ошибки ввода (раздел про карточку материала) — сменить
    номенклатуру уже существующей единицы, когда при вводе (например,
    начальных остатков) выбрали не тот материал/цвет/толщину/
    производителя. Единица физически никуда не переезжает, id и история
    движений сохраняются."""

    material: str
    color: str
    thickness: float
    manufacturer: str


class IssueRequest(BaseModel):
    material: str
    color: str
    thickness: float
    manufacturer: str
    width_mm: float = Field(gt=0)
    length_m: float = Field(gt=0)
    area: str
    production_task_line_id: int | None = None
    occurred_at: OccurredAt = None


class IssueDirectRequest(BaseModel):
    """Выдача конкретной единицы напрямую (3 раздел обратной связи) —
    оператор выбирает готовый рулон/штрипс из списка "в наличии" вместо
    поиска по атрибутам+ширине."""

    area: str
    production_task_line_id: int | None = None
    occurred_at: OccurredAt = None
    # Раздел про замену плёнки/правку штрипса на выдаче — та же
    # семантика, что у CuttingWidthSpec ниже: расхождение с ProductionTaskLine
    # примется как исправление и запомнится в строке только при наличии
    # права production_tasks.manage, иначе по-прежнему 409.
    override_strip_width: bool = False
    override_material: bool = False


class DonorSuggestion(BaseModel):
    """Рекомендация "донор-штрипс" (2.9 п.2 ТЗ) — не выполняется
    автоматически, только предлагается; оператор режет вручную через
    /units/{id}/split и подтверждает выдачу отдельным запросом."""

    unit_id: int
    width_mm: float
    length_m: float
    width_class: str
    recommended_cut_mm: float
    waste_mm: float
    days_in_storage: int = 0
    # Раздел про площадки — на каком складе физически лежит донор, чтобы
    # фронт мог предупредить, если он не совпадает с домашним складом
    # площадки участка (см. MaterialUnitOut.warehouse_name).
    warehouse_name: str | None = None


class IssueResult(BaseModel):
    outcome: str  # "issued" | "donor_suggested" | "not_found"
    unit: MaterialUnitOut | None = None
    donor: DonorSuggestion | None = None
    # Раздел про выдачу мимо хаба — на своём (домашнем) складе площадки
    # ничего не нашлось, но на другом складе подходящий остаток есть:
    # подсказать переместить через хаб, а не сразу заявку на закупку.
    elsewhere_warehouse_name: str | None = None


class CuttingPlanRequest(BaseModel):
    """Раздел про план резки на несколько разных штрипсов одной плёнки —
    needed_widths_mm обычно приходит из группы "одна плёнка на N заданий"
    на экране выдачи (каждая ширина — своя строка задания на сегодня)."""

    material: str
    color: str
    thickness: float
    manufacturer: str
    needed_widths_mm: list[float] = Field(min_length=1)


class CuttingPlanDonorOut(BaseModel):
    unit_id: int
    width_mm: float
    length_m: float
    days_in_storage: int


class CuttingPlanOut(BaseModel):
    donor: CuttingPlanDonorOut | None
    covered_widths_mm: list[float]
    uncovered_widths_mm: list[float]
    waste_mm: float
    # Индексы needed_widths_mm, которые донор покрывает (раздел про
    # исполнение плана) — при повторяющихся ширинах в запросе (два
    # задания просят одну и ту же ширину) значения covered_widths_mm
    # неоднозначны, индексы позволяют однозначно сопоставить обратно с
    # исходными строками задания на фронте.
    covered_indices: list[int]


class CutRequest(BaseModel):
    cut_length_m: float = Field(gt=0)
    remainder_location: str | None = None
    occurred_at: OccurredAt = None


class CuttingDestination(BaseModel):
    """Куда девается один отрезанный кусок (раздел про единую форму резки)
    — "keep" (остаётся на складе, опционально сразу с ячейкой), "issue"
    (сразу выдаётся участку/строке задания), "discard" (списывается на
    месте без своей единицы — только для отреза по длине, кусок ширины
    донора никогда не бывает "сразу отход", для этого его просто не
    режут), "transfer" (раздел про перемещение между складами — сразу в
    хаб на другой склад вместо места на своём)."""

    kind: Literal["keep", "issue", "discard", "transfer"]
    location_code: str | None = None
    area: str | None = None
    production_task_line_id: int | None = None
    to_warehouse_id: int | None = None


class CuttingWidthSpec(BaseModel):
    width_mm: float = Field(gt=0)
    destination: CuttingDestination
    actual_length_m: float | None = None
    # Раздел про правку штрипса прямо на выдаче (пока идёт тестирование
    # размеров) — по умолчанию ширина куска должна СТРОГО совпадать с
    # ожидаемой шириной строки задания (см. _validate_matches_task_line в
    # api/units.py); этот флаг просит вместо отказа принять введённую
    # ширину как исправление и запомнить её в строке задания — фактически
    # применяется только если у пользователя есть право production_tasks.
    # manage, иначе несовпадение по-прежнему блокируется.
    override_strip_width: bool = False
    # Раздел про замену плёнки на выдаче — донор может быть другой
    # номенклатурой, чем указано в строке задания (например, точной сейчас
    # нет на складе); при наличии права production_tasks.manage расхождение
    # примется и запомнится в строке вместо отказа.
    override_material: bool = False


class CuttingRecipeRequest(BaseModel):
    """Единая резка донора (раздел про объединение резки в одну форму) —
    опциональный отрез по длине на всю ширину донора, затем ноль и более
    кусков по ширине из остатка. Заменяет /split, /split-length,
    /issue-donor-atomic, /cutting-plan/execute одним атомарным запросом,
    с автосписанием остатка донора тоньше порога полезной ширины в конце
    (донор — общая логика с donor_remainder_write_off_m, ранее
    применявшаяся только в execute_cutting_plan)."""

    donor_unit_id: int
    length_precut_m: float | None = Field(default=None, gt=0)
    length_destination: CuttingDestination | None = None
    width_cuts: list[CuttingWidthSpec] = Field(default_factory=list)
    occurred_at: OccurredAt = None


class CuttingRecipeResultPiece(BaseModel):
    unit: MaterialUnitOut
    discrepancy_flagged: bool = False


class CuttingRecipeResponse(BaseModel):
    length_result: CuttingRecipeResultPiece | None
    width_results: list[CuttingRecipeResultPiece]
    donor_remainder: MaterialUnitOut


class CuttingOperationPieceOut(BaseModel):
    """Один кусок, рождённый резкой (раздел про историю резок) —
    destination_kind не хранится отдельно, выводится из текущего
    статуса/наличия ячейки: удобно для отображения в журнале, не для логики
    отмены (там своя, более строгая проверка — services/cutting_undo.py)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    width_mm: float
    length_m: float
    status: UnitStatus
    area: str | None
    location_code: str | None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def destination_kind(self) -> str:
        if self.status == UnitStatus.V_PEREMESHCHENII:
            return "transfer"
        if self.status == UnitStatus.VYDAN_UCHASTKU:
            return "issue"
        return "keep"


class CuttingOperationOut(BaseModel):
    """Строка журнала «История резки» (раздел про отмену резки и историю в
    «Заготовках») — can_undo/cannot_undo_reason предпосчитаны сервером через
    services/cutting_undo.check_undo_eligibility, той же функцией, что
    вызывает и сам эндпоинт отмены — фронту не нужно гадать самому."""

    id: int
    donor_unit_id: int
    donor_material_sku: MaterialSkuOut
    donor_width_before_mm: float
    donor_length_before_m: float
    donor_status_before: str
    donor_width_after_mm: float
    donor_length_after_m: float
    donor_status_after: str
    donor_auto_written_off: bool
    length_precut_m: float | None
    occurred_at: datetime
    created_at: datetime
    user_id: int
    user_name: str
    undone_at: datetime | None
    undone_by: int | None
    undone_by_name: str | None
    resulting_pieces: list[CuttingOperationPieceOut]
    can_undo: bool
    cannot_undo_reason: str | None


class ReturnRequest(BaseModel):
    actual_length_m: float = Field(ge=0)
    occurred_at: OccurredAt = None


class ReturnPreviewOut(BaseModel):
    """Подсказка перед возвратом (раздел про возврат остатка) — сколько
    плёнки должно остаться по расчёту (выдано минус хорошие и брак),
    прежде чем оператор физически обмерит и введёт фактическую длину.
    expected_return_length_m=None, если единица не привязана к строке
    задания — считать не из чего."""

    expected_return_length_m: float | None
    good_pieces: float
    defect_pieces: float


class UnitEventOut(BaseModel):
    """История единицы для карточки единицы (2.1 раздел бэклога доработок)
    — "кто и когда с ней что делал"."""

    model_config = ConfigDict(from_attributes=True)
    event_id: int
    event_type: EventType
    timestamp: datetime
    user_id: int
    from_length: float | None
    to_length: float | None
    from_cell: str | None
    to_cell: str | None
    quantity_delta_m: float
    write_off_reason: str | None
    write_off_note: str | None
    expected_length_m: float | None
