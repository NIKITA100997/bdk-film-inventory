"""Заявка на закупку — для любой позиции (14.10)

Была только плёнка (материал+цвет+толщина, м²). Теперь в заявке может быть
позиция номенклатуры (материал: МДФ, пенопласт, клей…) с количеством в её
единице и ценой за единицу; поля плёнки — необязательны.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7c9e1f3b5d6'
down_revision: Union[str, Sequence[str], None] = 'f6b8d0e2a4c5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("purchase_requests", sa.Column("item_id", sa.Integer, sa.ForeignKey("items.id"), nullable=True, index=True))
    op.add_column("purchase_requests", sa.Column("quantity", sa.Numeric(14, 3), nullable=True))
    op.add_column("purchase_requests", sa.Column("price_per_unit", sa.Numeric(14, 4), nullable=True))
    for col in ("material_id", "color_id", "thickness_id", "requested_area_m2"):
        op.alter_column("purchase_requests", col, nullable=True)


def downgrade() -> None:
    op.execute("delete from purchase_requests where item_id is not null")
    for col in ("material_id", "color_id", "thickness_id", "requested_area_m2"):
        op.alter_column("purchase_requests", col, nullable=False)
    op.drop_column("purchase_requests", "price_per_unit")
    op.drop_column("purchase_requests", "quantity")
    op.drop_column("purchase_requests", "item_id")
