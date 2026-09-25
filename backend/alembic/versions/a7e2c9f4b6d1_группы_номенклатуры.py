"""Группы номенклатуры (папки, как в 1С): item_groups + items.group_id.

Revision ID: a7e2c9f4b6d1
Revises: e6c9d3a8b1f7
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a7e2c9f4b6d1"
down_revision: Union[str, Sequence[str], None] = "e6c9d3a8b1f7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "item_groups",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind_id", sa.Integer(), sa.ForeignKey("item_kinds.id"), nullable=False, index=True),
        sa.Column("parent_id", sa.Integer(), sa.ForeignKey("item_groups.id"), nullable=True, index=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("items", sa.Column("group_id", sa.Integer(), sa.ForeignKey("item_groups.id"), nullable=True))
    op.create_index("ix_items_group_id", "items", ["group_id"])


def downgrade() -> None:
    op.drop_index("ix_items_group_id", table_name="items")
    op.drop_column("items", "group_id")
    op.drop_table("item_groups")
