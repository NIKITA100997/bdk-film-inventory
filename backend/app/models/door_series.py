from sqlalchemy import Boolean, CheckConstraint, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class DoorSeries(Base):
    """Серия щитовой двери (раздел про производство щитовых дверей) — то, что
    в графике запуска стоит в колонке «Серия». Из неё выводится маршрут
    двери по этапам (есть ли Кромка ABS, Фрезеровка под замок) и размеры
    п/ф: толщина каркаса и толщина МДФ панели берутся отсюда, а не из
    формулы в коде — по техкарте они различаются даже внутри одной буквы
    (А10 тоньше остальной А, Н бывает с щитом 6 и 8 мм).

    Названия заводятся ровно так, как пишутся в графике запуска — по ним
    строка графика сопоставляется с серией при вставке."""

    __tablename__ = "door_series"
    __table_args__ = (CheckConstraint("edge_type IN ('abs', 'aluminum')", name="ck_door_series_edge_type"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    frame_thickness_mm: Mapped[float] = mapped_column(Numeric(6, 2))
    panel_mdf_thickness_mm: Mapped[float] = mapped_column(Numeric(6, 2))
    # "abs" — Сборка перед отдельной Кромкой; "aluminum" — профиль ставится
    # на Сборке, отдельного этапа Кромки нет.
    edge_type: Mapped[str] = mapped_column(String(16))
    has_glass: Mapped[bool] = mapped_column(Boolean, default=False)
    has_moulding: Mapped[bool] = mapped_column(Boolean, default=False)
    needs_lock_milling: Mapped[bool] = mapped_column(Boolean, default=False)
    # Программа станка для фрезеровки периметра — ключ группировки дверей
    # под одну наладку на дашборде.
    milling_program: Mapped[str | None] = mapped_column(String(128), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
