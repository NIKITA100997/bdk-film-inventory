from sqlalchemy import Boolean, CheckConstraint, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class DoorSeries(Base):
    """Серия щитовой двери (раздел про производство щитовых дверей) —
    базовая серия из «Данных для формул» (В-10, Е-14, Н-1 ВО…). Варианты из
    графика запуска (В-10.2, Е-14.2) сопоставляются с базовой серией
    нормализацией названия (см. services/shield_schedule.py).

    Толщина каркаса и МДФ щита — атрибуты серии, не формула в коде: по
    техкарте они различаются и внутри одной буквы (А-10 тоньше остальной
    А, у Н-1 ВО щит 8 мм вместо 6).

    edge_type — кромка ПО УМОЛЧАНИЮ для серии. Стекло, молдинг и защёлка
    (фрезеровка под замок) — свойства конкретной строки заказа, берутся из
    её наименования: в реальных графиках они различаются внутри одной
    серии, как и кромка изредка (В-16.2 с алюминиевым профилем)."""

    __tablename__ = "door_series"
    __table_args__ = (CheckConstraint("edge_type IN ('abs', 'aluminum')", name="ck_door_series_edge_type"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    frame_thickness_mm: Mapped[float] = mapped_column(Numeric(6, 2))
    panel_mdf_thickness_mm: Mapped[float] = mapped_column(Numeric(6, 2))
    # "abs" — кромкооблицовка (ABS/ПЭТ) отдельным этапом после Сборки;
    # "aluminum" — профиль ставится на Сборке, этапа Кромки нет.
    edge_type: Mapped[str] = mapped_column(String(16))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
