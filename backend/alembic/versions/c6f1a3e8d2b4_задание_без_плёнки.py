"""Одно задание на любой участок: плёнка в строке задания необязательна,
ссылка строки на операцию техкарты (этап детали).

Revision ID: c6f1a3e8d2b4
Revises: b4d8f2a6e0c1
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c6f1a3e8d2b4"
down_revision: Union[str, Sequence[str], None] = "b4d8f2a6e0c1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for col in ("material_id", "color_id", "thickness_id"):
        op.alter_column("production_task_lines", col, existing_type=sa.Integer(), nullable=True)
    op.add_column("production_task_lines", sa.Column("part_stage_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_production_task_lines_part_stage_id", "production_task_lines", "part_stages", ["part_stage_id"], ["id"]
    )


def downgrade() -> None:
    op.drop_constraint("fk_production_task_lines_part_stage_id", "production_task_lines", type_="foreignkey")
    op.drop_column("production_task_lines", "part_stage_id")
    for col in ("material_id", "color_id", "thickness_id"):
        op.alter_column("production_task_lines", col, existing_type=sa.Integer(), nullable=False)
