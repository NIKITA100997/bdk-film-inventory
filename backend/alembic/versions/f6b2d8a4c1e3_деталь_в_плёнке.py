"""Деталь в плёнке — отдельная позиция «деталь · декор»: ссылка на деталь
без плёнки и декор (материал + цвет плёнки).

Revision ID: f6b2d8a4c1e3
Revises: e5a1c3f7b9d2
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f6b2d8a4c1e3"
down_revision: Union[str, Sequence[str], None] = "e5a1c3f7b9d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("items", sa.Column("base_item_id", sa.Integer(), sa.ForeignKey("items.id"), nullable=True))
    op.add_column("items", sa.Column("decor_material_id", sa.Integer(), sa.ForeignKey("materials.id"), nullable=True))
    op.add_column("items", sa.Column("decor_color_id", sa.Integer(), sa.ForeignKey("colors.id"), nullable=True))
    op.create_index("ix_items_base_item_id", "items", ["base_item_id"])


def downgrade() -> None:
    op.drop_index("ix_items_base_item_id", table_name="items")
    op.drop_column("items", "decor_color_id")
    op.drop_column("items", "decor_material_id")
    op.drop_column("items", "base_item_id")
