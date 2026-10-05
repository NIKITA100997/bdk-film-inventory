from pydantic import BaseModel, ConfigDict


class AreaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    code: str
    name: str
    is_active: bool
    # Раздел про площадки — id площадки (Северный/Фабрика), если участок к
    # ней привязан; сам домашний склад площадки фронт берёт из /sites, не
    # дублируем здесь.
    site_id: int | None = None
    # Раздел про отключение распределения по дням — False у участков,
    # которые планируются просто "на участок", без разбивки по дням.
    requires_daily_plan: bool = True
    # Отчёт по строке с плёнкой — только с рулоном; возврат рулона — только
    # после отчёта.
    requires_roll_on_report: bool = False
    # Плёнку режут на участке — выдаётся рулон целиком, ширина не проверяется.
    film_cut_on_site: bool = False
    # Планирование: сколько рабочих дней занимает операция участка.
    lead_days: int = 1
    # Мощность (задел): штук в смену и смен в день; пусто — не задана.
    capacity_per_shift: float | None = None
    shifts_per_day: int = 1
    # Припуск плёнки к ширине детали, мм; крупные партии — на другой участок.
    film_allowance_mm: float | None = None
    big_batch_area: str | None = None
    big_batch_min_pieces: float | None = None
    # По строкам не отчитываются — задание закрывают целиком.
    close_without_reports: bool = False
    # Оплата работ: piece — сдельно (₽ за шт), shift — за смену (₽ на
    # человека × людей в смене); пусто — не считается.
    pay_mode: str | None = None
    piece_rate: float | None = None
    shift_rate: float | None = None
    shift_headcount: float | None = None


class AreaCreate(BaseModel):
    name: str
    site_id: int | None = None
    requires_daily_plan: bool = True
    requires_roll_on_report: bool = False


class AreaUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None
    site_id: int | None = None
    requires_daily_plan: bool | None = None
    requires_roll_on_report: bool | None = None
    film_cut_on_site: bool | None = None
    lead_days: int | None = None
    # 0 — снять мощность (не задана).
    capacity_per_shift: float | None = None
    shifts_per_day: int | None = None
    # 0 — без припуска.
    film_allowance_mm: float | None = None
    # "" — не предлагать другой участок для крупных партий.
    big_batch_area: str | None = None
    big_batch_min_pieces: float | None = None
    close_without_reports: bool | None = None
    # "" — снять вид оплаты; 0 — снять ставку.
    pay_mode: str | None = None
    piece_rate: float | None = None
    shift_rate: float | None = None
    shift_headcount: float | None = None
