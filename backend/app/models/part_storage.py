from sqlalchemy import Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class PartRack(Base):
    """Стеллаж п/ф (раздел про адресное хранение деталей) — параллельная
    `Rack`/`storage.py`, не переиспользование: лоты п/ф считаются в штуках,
    не в метрах непрерывной длины, плюс `Rack` уже часть живой, ежедневно
    используемой системы учёта плёнки — трогать её ради нового
    несвязанного домена излишний риск регресса (см. BDK_Учет_ПФ_план.md).

    Полки — не отдельные строки в БД, а просто числа 1..shelf_count, как у
    `Rack` (адрес "ЗГ-1-01" — свободная строка на `PartUnit.location_code`).
    Без `warehouse_id`/лимитов занятости полки — п/ф физически живёт в
    одном цехе, между складами не путешествует, полка — просто адрес."""

    __tablename__ = "part_racks"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    shelf_count: Mapped[int] = mapped_column(Integer)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
