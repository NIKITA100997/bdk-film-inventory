from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.part_units import PartUnitStatus


class PartUnitCreate(BaseModel):
    """Регистрация партии начальником цеха (раздел про физический учёт
    деталей) — квант работы: один вызов = одна нарезанная партия. Раздел
    про "зачем кнопка выдать участку" — партия автоматически считается
    выданной участку, если у стартового этапа настроен участок (см.
    mint_part_unit) — отдельного выбора "выдать сразу или нет" больше
    нет. Раздел про связь этапов с участками — участок выводится из
    выбранного этапа, не выбирается вручную (см. PartStage.area).

    `stage_id` — раздел про регистрацию задним числом (партия физически
    уже прошла часть маршрута — например, уже склеена и отфрезерована —
    и заводится в систему только сейчас, не с нуля): какой этап считать
    стартовым. None — как раньше, первый этап детали (sequence_order=1)."""

    part_id: int
    quantity_pieces: float = Field(gt=0)
    production_task_line_id: int | None = None
    note: str | None = None
    stage_id: int | None = None
    # Раздел про учёт п/ф по FIFO — тот же приём "задним числом", что и
    # stage_id: None = сегодня.
    manufactured_at: date | None = None
    # Раздел про совместимость с плёнкой — код из PartFilmRestriction,
    # только видимая пометка на партии (см. модель PartUnit.film_restriction).
    film_restriction: str | None = None


class PartUnitPlace(BaseModel):
    location_code: str
    # Раздел про недостающее задним числом на мобильной карточке п/ф —
    # тот же приём, что уже есть у плёнки (OccurredAtField): None = сейчас.
    occurred_at: datetime | None = None


class PartUnitWriteOff(BaseModel):
    quantity_pieces: float = Field(gt=0)
    reason: str
    note: str | None = None
    occurred_at: datetime | None = None


class PartUnitReturn(BaseModel):
    """Вернуть партию на склад п/ф, не использовав (или использовав лишь
    частично) — раздел про ревизию путей п/ф, зеркалит ReturnRequest у
    плёнки (schemas/units.py)."""

    actual_quantity_pieces: float = Field(ge=0)
    occurred_at: datetime | None = None


class PartUnitAdjust(BaseModel):
    """Формальная корректировка quantity_pieces — раздел про ревизию
    путей плёнки/п/ф: поднадзорное действие вместо правки истории
    напрямую в БД, причина обязательна."""

    actual_quantity_pieces: float = Field(ge=0)
    reason: str
    note: str | None = None
    # Раздел про совместимость с плёнкой — можно проставить/поправить
    # пометку заодно с корректировкой количества, без пересоздания партии.
    film_restriction: str | None = None
    clear_film_restriction: bool = False
    occurred_at: datetime | None = None


class PartUnitRecycle(BaseModel):
    """"Переработать в деталь" — раздел про переработку брака: забрать
    резерв (статус В_переработку) детали source_part_id по FIFO и
    заминтить новую партию ДРУГОЙ детали target_part_id сразу на её
    этапе «Окутка» (см. recycle_part_units_fifo)."""

    source_part_id: int
    area: str
    quantity_pieces: float = Field(gt=0)
    target_part_id: int
    note: str | None = None


class PartUnitAdvance(BaseModel):
    """Перевод партии на следующий этап напрямую (раздел про мобильный
    скан-сценарий по этапам) — в отличие от отчёта мастера
    (create_task_line_report), не привязан к производственному заданию:
    для внутренних технологических переходов (склейка/фрезеровка), где
    расхода плёнки нет и заводить задание незачем."""

    quantity_pieces: float = Field(gt=0)
    occurred_at: datetime | None = None


class PartUnitOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    parent_id: int | None
    part_id: int
    part_name: str
    quantity_pieces: float
    # Раздел про ревизию путей п/ф — сколько реально доступно сейчас
    # (quantity_pieces за вычетом уже отчитанного по FIFO good_pieces,
    # см. reported_good_pieces_by_unit) — на последнем этапе партия,
    # полностью взятая в отчёт, не уменьшает quantity_pieces (см.
    # advance_part_unit), и выглядит доступной снова, если смотреть
    # только на это поле. quantity_available — та же поправка, что уже
    # предотвращает повторный расход внутри consume_part_units_fifo,
    # теперь видна и в самом интерфейсе.
    quantity_available: float
    stage_id: int
    stage_name: str
    status: PartUnitStatus
    area: str | None
    location_code: str | None
    production_task_line_id: int | None
    note: str | None
    film_restriction: str | None
    created_by: int
    manufactured_at: date
    created_at: datetime
    updated_at: datetime


class PartUnitEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_type: str
    quantity_delta: float
    from_stage_id: int | None
    to_stage_id: int | None
    from_cell: str | None
    to_cell: str | None
    area: str | None
    write_off_reason: str | None
    write_off_note: str | None
    # Раздел про переработку брака — на событии "Переработка" партии-
    # источника: id новой партии, в которую она переработалась.
    related_part_unit_id: int | None
    user_id: int
    occurred_at: datetime
    note: str | None
