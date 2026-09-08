from sqlalchemy import ForeignKey, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class WidthAnalogGroup(Base):
    """Группа взаимозаменяемых ширин штрипса плёнки (раздел про аналоги
    ширин при выдаче) — не привязана к конкретному материалу/детали:
    290мм у "Стоевой" и 290мм у "Поперечной" — один и тот же физический
    штрипс. Заводится ТОЛЬКО вручную (см. equivalent_widths,
    services/width_analogs.py) — попытка сделать это автоматическим
    допуском в мм уже один раз слепила РАЗНЫЕ реальные детали (см. сверку
    рулонов окутки в этой же сессии: 57/60мм и 65/68мм — разные детали,
    несмотря на близость)."""

    __tablename__ = "width_analog_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)

    members: Mapped[list["WidthAnalogMember"]] = relationship(
        back_populates="group", cascade="all, delete-orphan", order_by="WidthAnalogMember.width_mm"
    )


class WidthAnalogMember(Base):
    """Одна ширина внутри группы аналогов. UniqueConstraint на width_mm —
    ширина не может состоять в двух РАЗНЫХ группах одновременно, иначе
    транзитивно связала бы две несвязанные группы через себя."""

    __tablename__ = "width_analog_members"
    __table_args__ = (UniqueConstraint("width_mm", name="uq_width_analog_member_width"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("width_analog_groups.id", ondelete="CASCADE"))
    width_mm: Mapped[float] = mapped_column(Numeric(10, 2))

    group: Mapped[WidthAnalogGroup] = relationship(back_populates="members")
