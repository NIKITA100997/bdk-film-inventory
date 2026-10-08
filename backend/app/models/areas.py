"""Участки — раньше жёсткий enum (`Area` в `models/users.py`), теперь
создаваемая администратором сущность, по образцу `Role` (`models/roles.py`):
`code` — сам первичный ключ, не суррогатный id, значение то же, что раньше
хранилось как enum-значение ("okutka_tsargovykh" и т.д.), поэтому у всех
таблиц-потребителей (`users`, `material_units`, `material_events`,
`production_lines`, `product_models`, `product_model_parts`,
`production_tasks`) менялся только тип колонки (enum → строка с FK на
`areas.code`), не содержимое. Для участков, заведённых через UI, `code`
выводится из названия (см. `app/services/areas.py`) — в отличие от `Role`,
где `code` есть только у 7 системных ролей, здесь `code` заполнен всегда:
он и есть значение, которое хранится во всех таблицах-потребителях."""

from sqlalchemy import JSON, Integer, Boolean, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Area(Base):
    __tablename__ = "areas"

    code: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Раздел про площадки — участок опционально привязан к площадке
    # (Северный/Фабрика), у которой есть свой домашний склад; nullable,
    # потому что не все участки обязаны быть сгруппированы сразу.
    site_id: Mapped[int | None] = mapped_column(ForeignKey("sites.id"), nullable=True)
    # Раздел про отключение распределения по дням — по умолчанию True
    # (текущее поведение всех участков не меняется); False — участок
    # планируется просто "на участок", без разбивки по дням/бригадам:
    # мастеру не показываем "Распределить"/"План на день" для его заданий,
    # а на выдаче такие строки не помечаются как "не распределено"
    # (это нормальное для них состояние, а не сигнал "забыли спланировать").
    requires_daily_plan: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # Планирование (29.09): сколько рабочих дней занимает операция участка —
    # на столько раньше ставится предыдущая операция при расчёте сроков
    # заказа назад от отгрузки. Мощность участков пока не задаётся.
    lead_days: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    # Мощность (задел, 29.09): сколько штук участок делает за смену и смен
    # в день. Пусто — мощность не задана; планировщик показывает загрузку
    # против мощности там, где она есть. Расчёт сроков её пока не учитывает.
    capacity_per_shift: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    shifts_per_day: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    # Единая модель, пункт 5 — участок как рабочий центр: отчёт о
    # производстве по строке с плёнкой обязан указать рулон, а рулон нельзя
    # вернуть без отчёта (раньше — хардкод кода окутки царговых).
    requires_roll_on_report: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Плёнку режут на самом участке (02.10, мембранно-вакуумные прессы):
    # склад выдаёт рулон целиком, без нарезки на штрипсы, — ширина рулона
    # строке задания не обязана совпадать; расход в отчёте — по норме
    # (длина детали на штуку), факт уточняется при возврате остатка.
    film_cut_on_site: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Припуск плёнки к ширине детали, мм (03.10, вместо константы Фабрики):
    # широкоформатная окутка панелей — штрипс шире панели на 7 мм. Пусто —
    # штрипс в ширину детали.
    film_allowance_mm: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    # Крупные партии (03.10, вместо константы «от 200 панелей — Фабрика»):
    # операцию с плёнкой этого участка от big_batch_min_pieces штук
    # предлагать делать на участке big_batch_area. Пусто — не предлагать.
    big_batch_area: Mapped[str | None] = mapped_column(ForeignKey("areas.code"), nullable=True)
    big_batch_min_pieces: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    # По строкам не отчитываются (03.10, раньше — код «fabrika» во фронте):
    # задание закрывают целиком «всё сделано», плёнка списывается метражом.
    close_without_reports: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Остатки плёнки на склад не возвращаются (06.10: Фабрика, прессы) —
    # рулон/штрипс расходуют до конца, склад отмечает его «израсходован»
    # (раскрой до нуля, расход — не брак) и возврата не ждёт.
    film_no_return: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # По каким признакам позиции объединять строки заданий участка (08.10,
    # services/line_groups.py): коды свойств типа — «серия», «ширина»,
    # «высота», «цвет», «кромка», «замок»… Пусто — каждая строка отдельно.
    group_props: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Оплата работ (05.10, себестоимость по участкам): "piece" — сдельно,
    # piece_rate ₽ за годную штуку (операция может задать свою); "shift" —
    # за смену: shift_rate ₽ за смену на человека × shift_headcount человек ×
    # смен в день, за каждый день с выпуском. Пусто — работа не считается.
    pay_mode: Mapped[str | None] = mapped_column(String(8), nullable=True)
    piece_rate: Mapped[float | None] = mapped_column(Numeric(12, 4), nullable=True)
    shift_rate: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    shift_headcount: Mapped[float | None] = mapped_column(Numeric(6, 2), nullable=True)
