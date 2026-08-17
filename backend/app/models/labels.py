"""Макет этикетки как структура, не HTML (4 раздел бэклога доработок).
Раньше singleton-строка (id=1), как CalcSettings — один активный макет
на всё предприятие. Теперь один макет на kind (раздел про этикетки
стеллажей/полок — "unit" для рулонов/штрипсов, "rack" для мест
хранения), kind уникален, id остаётся суррогатным ключом."""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class LabelTemplate(Base):
    __tablename__ = "label_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), unique=True, default="unit")
    width_mm: Mapped[int] = mapped_column(Integer, default=60)
    height_mm: Mapped[int] = mapped_column(Integer, default=90)
    # [{"key": "unit_id", "size": "lg", "bold": true}, ...] — порядок списка
    # это порядок строк на этикетке (сверху вниз).
    fields: Mapped[list] = mapped_column(JSONB, default=list)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
