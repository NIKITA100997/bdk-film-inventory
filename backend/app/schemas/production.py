from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class ProductionLineCreate(BaseModel):
    name: str
    area: str


class ProductionLineUpdate(BaseModel):
    name: str | None = None
    area: str | None = None
    is_active: bool | None = None


class ProductionLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    area: str
    is_active: bool


class ProductModelCreate(BaseModel):
    name: str
    area: str
    is_trim: bool = False


class ProductModelUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None
    is_trim: bool | None = None


class ProductModelPartCreate(BaseModel):
    area: str
    qty_per_unit: float = Field(gt=0)
    width_mm: float = Field(gt=0)
    length_m: float = Field(gt=0)
    strip_width_mm: float | None = None
    part_name: str | None = None


class ProductModelPartOut(BaseModel):
    id: int
    area: str
    qty_per_unit: float
    width_mm: float
    length_m: float
    strip_width_mm: float | None = None
    part_name: str | None


class ProductModelOut(BaseModel):
    id: int
    name: str
    area: str
    is_active: bool
    is_trim: bool
    parts: list[ProductModelPartOut] = []


class ProductionTaskLineManualCreate(BaseModel):
    line_id: int | None = None
    material: str
    color: str
    thickness: float
    quantity_pieces: float = Field(gt=0)
    width_mm: float = Field(gt=0)
    length_m: float = Field(gt=0)
    strip_width_mm: float | None = None
    part_name: str | None = None


class SkuCandidateOut(BaseModel):
    sku_id: int
    label: str


class NaryadParsedLineOut(BaseModel):
    part_name: str
    width_mm: float
    length_m: float
    quantity_pieces: float
    # Раздел про короб МДФ (наряд-заказ, погонаж) — ширина полосы ПВХ
    # зависит от двух чисел профиля (ширина+глубина), которые есть только
    # в тексте названия при разборе; для остальных типов деталей — берётся
    # из найденного совпадения в справочнике (см. suggested_part_id), а
    # если совпадения нет — None, ширина плёнки досчитывается стандартно
    # при создании строки задания (calc_default_strip_width).
    strip_width_mm: float | None = None
    # Раздел про соответствие деталям (services.naryad_import.enrich_naryad_lines)
    # — id найденной в справочнике детали при уверенном совпадении по
    # категории+размерам; None, если совпадения не нашлось.
    suggested_part_id: int | None = None
    # Раздел про доборный погонаж со своим цветом на строку — та же
    # построчная подсказка материала, что и у плана заготовок
    # (BlankPlanParsedLineOut ниже), только источник цвета другой (скобки
    # в названии, а не отдельная колонка); None у РАСКЛАДКИ.
    color_raw: str | None = None
    suggested_sku_id: int | None = None
    material: str | None = None
    thickness: float | None = None
    sku_candidates: list[SkuCandidateOut] = []


class NaryadParseResultOut(BaseModel):
    """Раздел про загрузку наряд-заказа — только форма деталей, без
    плёнки: материал/цвет/толщину и участок пользователь выбирает
    отдельно на фронтенде, тем же полем, что и для строк из BOM
    (ProductionTaskLineManualCreate.material/color/thickness)."""

    suggested_name: str
    lines: list[NaryadParsedLineOut]
    # Тот же номер, что уже вклеен в suggested_name текстом — отдельным
    # полем, чтобы форма создания задания могла предзаполнить структурное
    # поле, а не только текстовый ярлык.
    order_number: int | None = None


class BlankPlanParsedLineOut(BaseModel):
    """Раздел про импорт плана заготовок (Excel) — в отличие от
    NaryadParsedLineOut, здесь цвет свой у каждой строки (не общий на всё
    задание), поэтому подбор материала/детали делается построчно ещё на
    сервере (services.blank_plan_import.enrich_blank_plan_blocks) — если
    получилось однозначно, поля уже заполнены подсказкой, которую можно
    поправить на фронтенде; если нет — пустые, и фронтенд не даст создать
    задание, пока оператор не заполнит их вручную. sku_candidates — раздел
    обратной связи: несколько похожих по сочетанию материал+цвет позиций,
    когда однозначно подобрать не вышло, чтобы оператор выбрал одним
    кликом, а не искал заново с нуля."""

    part_name: str
    suggested_part_id: int | None = None
    width_mm: float | None = None
    length_m: float | None = None
    strip_width_mm: float | None = None
    color_raw: str
    suggested_sku_id: int | None = None
    material: str | None = None
    thickness: float | None = None
    quantity_pieces: float
    sku_candidates: list[SkuCandidateOut] = []


class BlankPlanBlockOut(BaseModel):
    sheet_name: str
    suggested_name: str
    lines: list[BlankPlanParsedLineOut]


class BlankPlanParseResultOut(BaseModel):
    blocks: list[BlankPlanBlockOut]


class ProductionTaskManualCreate(BaseModel):
    name: str
    area: str
    product_model_id: int | None = None
    quantity: int | None = None
    external_order_ref: int | None = None
    lines: list[ProductionTaskLineManualCreate] = Field(min_length=1)


class ProductionTaskLineReportCreate(BaseModel):
    # Раздел про брак по дням — отчёт обычно за конкретную запись
    # распределения (день/линия/сотрудники), не за строку задания целиком.
    # Раздел про отключение распределения по дням — для участка с
    # Area.requires_daily_plan=False допускается None (эндпоинт это
    # проверяет сам, см. create_task_line_report); для обычного участка
    # по-прежнему обязателен.
    assignment_id: int | None = None
    # Раздел про цифровой аналог "Ежедневки" (пилот: окутка царговых) —
    # из какого рулона резали; эндпоинт требует его для участков, где
    # включён этот учёт, для остальных остаётся необязательным.
    material_unit_id: int | None = None
    # Раздел про физический учёт деталей (пилот: окутка царговых) — какая
    # партия п/ф укутывалась; необязательно даже для этого участка (не у
    # каждой детали ещё настроены этапы, см. create_task_line_report).
    part_unit_id: int | None = None
    good_pieces: float = Field(ge=0)
    defect_pieces: float = Field(ge=0)
    defect_reason: str | None = None
    note: str | None = None


class ProductionTaskLineReportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    assignment_id: int | None
    material_unit_id: int | None
    part_unit_id: int | None
    good_pieces: float
    defect_pieces: float
    defect_reason: str | None
    note: str | None
    reported_by: int
    reported_at: datetime


class ProductionTaskLineAssignmentCreate(BaseModel):
    line_id: int
    date: date
    employee_names: str = Field(min_length=1)
    quantity_pieces: float = Field(gt=0)


class ProductionTaskLineAssignmentOut(BaseModel):
    id: int
    line_id: int
    line_name: str
    date: date
    employee_names: str
    quantity_pieces: float
    created_by: int
    created_at: datetime
    # Агрегаты по ProductionTaskLineReport, отфильтрованным по этой
    # конкретной записи распределения (раздел про брак по дням) — именно
    # это позволяет видеть факт/брак за конкретный день, а не за всю
    # строку задания.
    produced_good_pieces: float = 0.0
    defect_pieces: float = 0.0
    # Раздел про цифровой аналог "Ежедневки" — рулон, из которого резали
    # в рамках этой записи распределения (день/линия), и его метраж на
    # момент выдачи/сейчас. None — если по этой записи ещё не отчитались
    # ни разу с указанием рулона (участок либо не пилотирует эту фичу,
    # либо отчёт ещё не подан).
    material_unit_id: int | None = None
    issued_length_m: float | None = None
    remaining_length_m: float | None = None


class ProductionTaskLineSpecUpdate(BaseModel):
    """Правка размера/материала уже созданной строки задания (пока идёт
    тестирование размеров и не всегда хватает нужной номенклатуры) —
    width_mm/length_m нельзя очистить (не nullable на модели),
    strip_width_mm можно вернуть в null — обратно на "авто" по
    calc_default_strip_width, поэтому у него отдельная семантика "передано
    ли поле вообще" через model_fields_set в самом эндпоинте. sku_id —
    смена материала/цвета/толщины разом на существующую позицию
    номенклатуры (эндпоинт сам берёт material_id/color_id/thickness_id из
    неё) — та же идея, что override_material на резке/выдаче
    (units.py::_validate_matches_task_line), только явно, из самого
    задания, без похода в другой экран."""

    width_mm: float | None = Field(default=None, gt=0)
    length_m: float | None = Field(default=None, gt=0)
    strip_width_mm: float | None = Field(default=None, gt=0)
    sku_id: int | None = None


class ProductionTaskLineIssuedUnitOut(BaseModel):
    """Единица (рулон/штрипс) под эту строку задания — раздел про единый
    процесс возврата: отсюда кнопка «Вернуть на склад» прямо в задании,
    без похода в «Остатки» на поиск конкретной единицы.

    status (раздел про разбор задания единой таблицей) различает три
    реальных состояния одного и того же куска: "Выдан_участку" — физически
    у участка; "В_перемещении" — уже решено выдать, но едет через хаб на
    другой склад (домашний склад участка — например, "Фабрика"); "На_
    хранении" — хаб уже принял, кусок лежит на складе назначения, но ещё
    не довыдан участку локально там (production_task_line_id остаётся,
    хотя формально это снова просто остаток на складе)."""

    id: int
    width_mm: float
    length_m: float
    material_sku_id: int
    parent_id: int | None
    is_strip: bool
    status: str
    # Раздел про цифровой аналог "Ежедневки" без распределения по дням —
    # сколько метров этого конкретного рулона совокупно осталось (length_m
    # выше — это выданное, неизменное с момента выдачи количество; здесь —
    # за вычетом всех отчётов, что уже ссылались на этот рулон).
    remaining_length_m: float


class ProductionTaskLineOut(BaseModel):
    id: int
    line_id: int | None
    line_name: str
    material: str
    color: str
    thickness: float
    quantity_pieces: float
    width_mm: float
    length_m: float
    strip_width_mm: float | None = None
    part_name: str | None
    # Раздел про закрытие строки задания по выдаче — ручной флаг "выдача
    # закрыта", не производная величина (см. models/production.py).
    is_closed: bool = False
    # Агрегаты по ProductionTaskLineReport (раздел про брак в
    # производстве) — quantity_pieces сама не мутируется, остаток считается
    # на лету из накопительного журнала отчётов.
    produced_good_pieces: float
    defect_pieces: float
    remaining_pieces: float
    remaining_length_m: float
    # Раздел про очередь «потребности» на выдаче участку — сколько ещё
    # реально нужно довыдать плёнки (по нехватке выданного, не по голому
    # остатку штук); 0, если выдано достаточно, даже когда remaining_pieces
    # ещё не обнулился (производство просто не отчиталось).
    shortfall_length_m: float
    # Агрегаты по ProductionTaskLineAssignment (раздел про распределение по
    # линиям) — сколько из quantity_pieces уже расписано по линиям/дням.
    assigned_pieces: float
    unassigned_pieces: float
    assignments: list[ProductionTaskLineAssignmentOut] = []
    # Раздел про план/факт по расходу плёнки — сколько метров плёнки
    # положено по количеству деталей (quantity_pieces × length_m), план
    # не мутируется, задаётся один раз при создании строки задания.
    planned_length_m: float = 0.0
    # Раздел "Выдано по заданиям" на экране "Выдача участку" — сколько
    # метров плёнки реально выдано складом под эту строку (журнал
    # Выдача_участку), независимо от того, что с этим потом стало. Это же
    # число — «факт» в плане/факте: warehouse-driven, не зависит от того,
    # отчитался ли цех о производстве бумажно (на практике не используется).
    issued_length_m: float = 0.0
    # Раздел про единый процесс возврата — какие конкретно единицы сейчас
    # выданы под эту строку и могут быть возвращены прямо отсюда (обычно
    # 0 или 1, но не мутируется в записи — участок мог получать довыдачи).
    issued_units: list[ProductionTaskLineIssuedUnitOut] = []


class ProductionTaskOut(BaseModel):
    id: int
    product_model_id: int | None
    product_model_name: str | None
    name: str | None
    area: str
    quantity: int | None
    external_order_ref: int | None
    created_by: int
    created_at: datetime
    is_active: bool
    lines: list[ProductionTaskLineOut]
    # Раздел про план/факт по расходу плёнки — сумма planned_length_m/
    # issued_length_m по всем строкам задания, чтобы видеть прогресс по
    # заданию в целом, не только по каждой строке отдельно.
    planned_length_m: float = 0.0
    issued_length_m: float = 0.0


class BlankDemandLineOut(BaseModel):
    """Раздел про «Заготовки» — сколько плёнки этой позиции и ширины ещё
    нужно по ВСЕМ активным заданиям (не только уже распределённым по
    дням/линиям, в отличие от очереди «Выдача участку») в сравнении с тем,
    сколько уже нарезано и лежит на складе никому не назначенным
    (production_task_line_id IS NULL)."""

    material: str
    color: str
    thickness: float
    width_mm: float
    needed_length_m: float
    on_hand_length_m: float
    deficit_length_m: float
