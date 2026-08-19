from sqlalchemy import Boolean, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class WriteOffReasonEntry(Base):
    """Причина списания/брака (раздел про администрирование причин) —
    раньше жёсткий enum, теперь управляемая таблица, тот же паттерн, что
    Area (backend/app/models/areas.py): название редактируется, code —
    стабильный идентификатор, выводится сервером из названия и не
    меняется. Одна и та же причина используется и на списании единицы
    (MaterialEvent.write_off_reason), и на браке в производстве
    (ProductionTaskLineReport.defect_reason).

    "Отход при раскрое" — проставляется только системой при продольной
    резке ниже порога полезной ширины (app/api/units.py::split_unit),
    is_system=True не даёт ей попасть в список для формы списания/брака,
    какой бы ни была is_active.

    category — "warehouse"/"production"/"general" (раздел про модуль "Брак
    и списания"): чем пикер причины на списании единицы фильтрует список
    (warehouse+general), и чем отчёт о браке на производстве — отдельно
    (production+general). Одна таблица вместо двух — решает открытый
    вопрос бэклога (п. 12.6) без раздвоения справочника."""

    __tablename__ = "write_off_reasons"

    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    category: Mapped[str] = mapped_column(String(20), default="general")
