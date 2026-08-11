from pydantic import BaseModel, ConfigDict

from app.models.users import Area
from app.schemas.roles import RoleOut


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    full_name: str
    roles: list[RoleOut]
    is_superuser: bool
    area: Area | None
    is_active: bool


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class CurrentUserOut(BaseModel):
    """/auth/me — в отличие от UserOut отдаёт не структуру ролей, а уже
    посчитанный плоский список эффективных прав (8.3 раздел бэклога
    доработок): фронт гейтит навигацию по кодам прав, а не разбирает,
    какая роль что даёт."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    full_name: str
    roles: list[RoleOut]
    is_superuser: bool
    permissions: list[str]
    area: Area | None
    is_active: bool


class UserCreate(BaseModel):
    username: str
    full_name: str
    # Непустой, если не суперпользователь — проверяется в эндпоинте (8.3
    # раздел бэклога доработок), т.к. само наличие "начальника участка" среди
    # выбранных ролей резолвится по коду ролей из БД, недоступному на уровне
    # чистой pydantic-валидации без похода в БД.
    role_ids: list[int] = []
    is_superuser: bool = False
    area: Area | None = None
    # Если не задан — сервер сгенерирует временный пароль и вернёт его в
    # ответе один раз (3 раздел бэклога: "логин, временный пароль").
    password: str | None = None


class UserCreateResult(BaseModel):
    user: UserOut
    temporary_password: str


class UserUpdate(BaseModel):
    full_name: str | None = None
    role_ids: list[int] | None = None
    is_superuser: bool | None = None
    area: Area | None = None
    is_active: bool | None = None


class ResetPasswordResult(BaseModel):
    temporary_password: str
