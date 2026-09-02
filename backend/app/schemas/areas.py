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


class AreaCreate(BaseModel):
    name: str
    site_id: int | None = None
    requires_daily_plan: bool = True


class AreaUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None
    site_id: int | None = None
    requires_daily_plan: bool | None = None
