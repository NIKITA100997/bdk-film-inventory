"""План производства: слоты «строка задания × день × штуки» и срок
операции участка в рабочих днях.

Revision ID: a2c7e5f9b3d1
Revises: f3a8c1d6e2b9
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a2c7e5f9b3d1"
down_revision: Union[str, Sequence[str], None] = "f3a8c1d6e2b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("areas", sa.Column("lead_days", sa.Integer(), nullable=False, server_default="1"))
    op.create_table(
        "production_plan_slots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "task_line_id", sa.Integer(), sa.ForeignKey("production_task_lines.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("quantity", sa.Numeric(12, 2), nullable=False),
        sa.Column("auto", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_production_plan_slots_task_line_id", "production_plan_slots", ["task_line_id"])
    op.create_index("ix_production_plan_slots_date", "production_plan_slots", ["date"])


def downgrade() -> None:
    op.drop_index("ix_production_plan_slots_date", table_name="production_plan_slots")
    op.drop_index("ix_production_plan_slots_task_line_id", table_name="production_plan_slots")
    op.drop_table("production_plan_slots")
    op.drop_column("areas", "lead_days")
