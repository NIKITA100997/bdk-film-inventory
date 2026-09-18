from sqlalchemy import Boolean, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class PartFilmRestriction(Base):
    """Пометка совместимости партии п/ф с определённым видом плёнки для
    окутки (раздел про физический учёт деталей: заготовки с кромкой/под
    аляску/ламис из одной и той же детали физически не взаимозаменяемы —
    видно уже на конкретной партии, не на самой детали, т.к. одна и та же
    деталь может иметь и обычные, и ограниченные партии одновременно).

    Управляемый справочник (тот же приём, что WriteOffReasonEntry), не
    enum — список видов будет расширяться, конкретные плёнки под каждую
    пометку пока не зафиксированы. Сейчас — только видимая пометка на
    партии (PartUnit.film_restriction), не участвует в подборе партии по
    FIFO (по решению пользователя: "пока только пометка/видимость")."""

    __tablename__ = "part_film_restrictions"

    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
