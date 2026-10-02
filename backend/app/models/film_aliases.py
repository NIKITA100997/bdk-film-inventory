"""Сопоставления плёнки (02.10): текст из внешних источников — графиков
запуска, нарядов, планов заготовок, 1С — к плёнке справочника («Bolton Oak»
→ ПВХ Дуб болтон, «Полипропилен INVISIBLE Белый грунтовочный» → Полипропилен
Инвизибол 0.18). Общие для всей программы: всё, что подбирает плёнку по
тексту, сначала смотрит сюда."""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class FilmAlias(Base):
    __tablename__ = "film_aliases"

    id: Mapped[int] = mapped_column(primary_key=True)
    # как написано в источнике и ключ сравнения (без скобок, регистра, ё)
    text: Mapped[str] = mapped_column(String(255))
    key: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id"))
    color_id: Mapped[int] = mapped_column(ForeignKey("colors.id"))
    # пусто — любая толщина этой плёнки
    thickness_id: Mapped[int | None] = mapped_column(ForeignKey("thicknesses.id"), nullable=True)
    # откуда текст: «график щитовых», «наряд», «вручную»…
    source: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
