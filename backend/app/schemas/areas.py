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
