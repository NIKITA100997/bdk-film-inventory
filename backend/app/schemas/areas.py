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
