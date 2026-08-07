import enum

from sqlalchemy import Boolean, Enum, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserRole(str, enum.Enum):
    NACHALNIK_TSEKHA = "nachalnik_tsekha"
    NACHALNIK_UCHASTKA = "nachalnik_uchastka"
    OPERATOR_SKLADA = "operator_sklada"
    KLADOVSHCHIK = "kladovshchik"
    SNABZHENETS = "snabzhenets"
    LOGIST = "logist"
    ADMIN = "admin"


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
    role: Mapped[UserRole] = mapped_column(Enum(UserRole, name="user_role"))
    # Заполняется только для role=NACHALNIK_UCHASTKA — определяет, каким
    # участком руководит пользователь (влияет, например, на доступ к раскрою
    # на цельнолистовых, см. 2.4/6.4 ТЗ).
    area: Mapped[Area | None] = mapped_column(Enum(Area, name="area"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
