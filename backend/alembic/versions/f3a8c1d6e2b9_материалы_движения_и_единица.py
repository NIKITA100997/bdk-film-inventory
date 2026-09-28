"""Материалы: своя единица у позиции и движения материалов (приход,
расход, списание, инвентаризация).

Revision ID: f3a8c1d6e2b9
Revises: e9c4a7b2d5f8
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f3a8c1d6e2b9"
down_revision: Union[str, Sequence[str], None] = "e9c4a7b2d5f8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("items", sa.Column("unit", sa.String(16), nullable=True))
    op.create_table(
        "material_moves",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("item_id", sa.Integer(), sa.ForeignKey("items.id"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("qty", sa.Numeric(14, 4), nullable=False),
        sa.Column(
            "task_line_id", sa.Integer(), sa.ForeignKey("production_task_lines.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("doc", sa.String(64), nullable=True),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_material_moves_item_id", "material_moves", ["item_id"])
    op.create_index("ix_material_moves_task_line_id", "material_moves", ["task_line_id"])
    op.create_index("ix_material_moves_occurred_at", "material_moves", ["occurred_at"])


def downgrade() -> None:
    op.drop_index("ix_material_moves_occurred_at", table_name="material_moves")
    op.drop_index("ix_material_moves_task_line_id", table_name="material_moves")
    op.drop_index("ix_material_moves_item_id", table_name="material_moves")
    op.drop_table("material_moves")
    op.drop_column("items", "unit")
