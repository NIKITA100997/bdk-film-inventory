from pydantic import BaseModel, ConfigDict, model_validator

from app.models.users import Area, UserRole
from app.services.users import area_is_missing, resolve_area


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    full_name: str
    role: UserRole
    area: Area | None
    is_active: bool


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserCreate(BaseModel):
    username: str
    full_name: str
    role: UserRole
    area: Area | None = None
    # Если не задан — сервер сгенерирует временный пароль и вернёт его в
    # ответе один раз (3 раздел бэклога: "логин, временный пароль").
    password: str | None = None

    @model_validator(mode="after")
    def _area_only_for_uchastka(self):
        self.area = resolve_area(self.role, self.area)
        if area_is_missing(self.role, self.area):
            raise ValueError("Для роли «начальник участка» нужно указать участок")
        return self


class UserCreateResult(BaseModel):
    user: UserOut
    temporary_password: str


class UserUpdate(BaseModel):
    full_name: str | None = None
    role: UserRole | None = None
    area: Area | None = None
    is_active: bool | None = None


class ResetPasswordResult(BaseModel):
    temporary_password: str
