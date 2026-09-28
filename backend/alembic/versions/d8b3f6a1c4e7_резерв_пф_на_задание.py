"""Резерв п/ф на задание цеха и задание п/ф «под задание».

Revision ID: d8b3f6a1c4e7
Revises: c5f1a9d3e7b2
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d8b3f6a1c4e7"
down_revision: Union[str, Sequence[str], None] = "c5f1a9d3e7b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "part_reservations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("task_id", sa.Integer(), sa.ForeignKey("production_tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("part_id", sa.Integer(), sa.ForeignKey("parts.id"), nullable=False),
        sa.Column("quantity_pieces", sa.Numeric(12, 2), nullable=False),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("task_id", "part_id", name="uq_part_reservations_task_part"),
    )
    op.create_index("ix_part_reservations_task_id", "part_reservations", ["task_id"])
    op.create_index("ix_part_reservations_part_id", "part_reservations", ["part_id"])
    op.add_column(
        "production_tasks",
        sa.Column("for_task_id", sa.Integer(), sa.ForeignKey("production_tasks.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("ix_production_tasks_for_task_id", "production_tasks", ["for_task_id"])


def downgrade() -> None:
    op.drop_index("ix_production_tasks_for_task_id", table_name="production_tasks")
    op.drop_column("production_tasks", "for_task_id")
    op.drop_index("ix_part_reservations_part_id", table_name="part_reservations")
    op.drop_index("ix_part_reservations_task_id", table_name="part_reservations")
    op.drop_table("part_reservations")
