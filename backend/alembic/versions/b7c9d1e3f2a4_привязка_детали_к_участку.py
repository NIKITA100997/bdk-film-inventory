"""привязка детали к участку

Добавляет parts.area (необязательный FK на areas.code) — раздел про
привязку деталей к участку: справочник разросся за счёт нескольких
разных наборов деталей от разных участков, PartSelect теперь фильтрует
по участку формы-потребителя. NULL — деталь общая, видна независимо от
участка (существующие 138 записей остаются без привязки, ничего не
переносим автоматически — привязка расставляется вручную по мере
надобности).

Revision ID: b7c9d1e3f2a4
Revises: f5a5e29c642f
Create Date: 2026-08-26 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b7c9d1e3f2a4'
down_revision: Union[str, Sequence[str], None] = 'f5a5e29c642f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("parts", sa.Column("area", sa.String(length=128), nullable=True))
    op.create_foreign_key("fk_parts_area_areas", "parts", "areas", ["area"], ["code"])


def downgrade() -> None:
    op.drop_constraint("fk_parts_area_areas", "parts", type_="foreignkey")
    op.drop_column("parts", "area")
