import enum

from sqlalchemy import Boolean, Enum, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.roles import Role, user_roles


class UserRole(str, enum.Enum):
    """Коды 7 системных ролей, заведённых миграцией `roles`/`role_permissions`
    (8.3 раздел бэклога доработок) — больше не тип колонки БД (роль теперь
    M2M через `user_roles`), используется только как источник стабильных
    `Role.code` для сидинга и для проверок вроде "это начальник участка"
    (см. services/users.resolve_area), не зависящих от того, как
    администратор переименовал роль в UI."""

    NACHALNIK_TSEKHA = "nachalnik_tsekha"
    NACHALNIK_UCHASTKA = "nachalnik_uchastka"
    OPERATOR_SKLADA = "operator_sklada"
    KLADOVSHCHIK = "kladovshchik"
    SNABZHENETS = "snabzhenets"
    LOGIST = "logist"
    # Продажник (8 раздел обратной связи) — считает заказ клиенту и видит
    # предложения аналогов из неликвида; не работает со складскими операциями.
    PRODAZHNIK = "prodazhnik"


class Area(str, enum.Enum):
    OKUTKA_TSARGOVYKH = "okutka_tsargovykh"
    SHCHITOVYE_DVERI = "shchitovye_dveri"
    TSELNOLISTOVYE_DVERI = "tselnolistovye_dveri"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    full_name: Mapped[str] = mapped_column(String(255))
    # Суперпользователь — отдельный флаг, а не роль (8.3 раздел бэклога
    # доработок): проходит все require_permission без обращения к таблице
    # прав, чтобы систему нельзя было случайно "запереть", отредактировав
    # права роли, которую по ошибке приняли за административную.
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False)
    roles: Mapped[list[Role]] = relationship(secondary=user_roles)
    # Заполняется только если среди ролей есть "начальник участка" — определяет,
    # каким участком руководит пользователь (влияет, например, на доступ к
    # раскрою на цельнолистовых, см. 2.4/6.4 ТЗ).
    area: Mapped[Area | None] = mapped_column(Enum(Area, name="area"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
