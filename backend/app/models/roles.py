"""Гибкая ролевая модель (8.3 раздел бэклога доработок) — роль больше не
жёсткий enum, а создаваемая администратором сущность с назначаемым набором
прав. `Permission` — фиксированный каталог (каждое право жёстко привязано к
конкретной проверке в коде через require_permission), не редактируется через
UI, только назначается ролям. `code` у `Role` заполнен и неизменяем только у
7 системных ролей (из миграции, под старые значения `UserRole`) — нужен
`resolve_area`, чтобы узнавать "начальника участка" независимо от того, как
администратор переименовал роль; у ролей, созданных через UI, `code=None`."""

from sqlalchemy import Boolean, Column, ForeignKey, String, Table
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

role_permissions = Table(
    "role_permissions",
    Base.metadata,
    Column("role_id", ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
    Column("permission_id", ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
)

user_roles = Table(
    "user_roles",
    Base.metadata,
    Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("role_id", ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
)


class Permission(Base):
    __tablename__ = "permissions"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(255))
    section: Mapped[str] = mapped_column(String(64))


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    permissions: Mapped[list[Permission]] = relationship(secondary=role_permissions)
