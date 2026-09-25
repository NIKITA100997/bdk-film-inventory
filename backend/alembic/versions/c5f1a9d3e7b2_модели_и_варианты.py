"""Модель и варианты: items.is_model, items.model_id, item_types.model_property_id.

Revision ID: c5f1a9d3e7b2
Revises: b3d8e1f5a2c4
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c5f1a9d3e7b2"
down_revision: Union[str, Sequence[str], None] = "b3d8e1f5a2c4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("items", sa.Column("is_model", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("items", sa.Column("model_id", sa.Integer(), sa.ForeignKey("items.id"), nullable=True))
    op.create_index("ix_items_model_id", "items", ["model_id"])
    op.add_column(
        "item_types",
        sa.Column("model_property_id", sa.Integer(), sa.ForeignKey("item_properties.id", ondelete="SET NULL"), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("item_types", "model_property_id")
    op.drop_index("ix_items_model_id", table_name="items")
    op.drop_column("items", "model_id")
    op.drop_column("items", "is_model")
