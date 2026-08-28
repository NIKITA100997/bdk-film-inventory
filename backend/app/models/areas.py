"""Участки — раньше жёсткий enum (`Area` в `models/users.py`), теперь
создаваемая администратором сущность, по образцу `Role` (`models/roles.py`):
`code` — сам первичный ключ, не суррогатный id, значение то же, что раньше
хранилось как enum-значение ("okutka_tsargovykh" и т.д.), поэтому у всех
таблиц-потребителей (`users`, `material_units`, `material_events`,
`production_lines`, `product_models`, `product_model_parts`,
`production_tasks`) менялся только тип колонки (enum → строка с FK на
`areas.code`), не содержимое. Для участков, заведённых через UI, `code`
выводится из названия (см. `app/services/areas.py`) — в отличие от `Role`,
где `code` есть только у 7 системных ролей, здесь `code` заполнен всегда:
он и есть значение, которое хранится во всех таблицах-потребителях."""

from sqlalchemy import Boolean, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Area(Base):
    __tablename__ = "areas"

    code: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Раздел про площадки — участок опционально привязан к площадке
    # (Северный/Фабрика), у которой есть свой домашний склад; nullable,
    # потому что не все участки обязаны быть сгруппированы сразу.
    site_id: Mapped[int | None] = mapped_column(ForeignKey("sites.id"), nullable=True)
