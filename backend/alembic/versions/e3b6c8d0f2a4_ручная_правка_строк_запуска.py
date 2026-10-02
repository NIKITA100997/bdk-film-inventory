"""Строка задания: программа станка, указание мастеру, ручные правки при запуске

Revision ID: e3b6c8d0f2a4
Revises: d2a5b7c9e1f3
Create Date: 2026-10-02 22:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e3b6c8d0f2a4'
down_revision: Union[str, Sequence[str], None] = 'd2a5b7c9e1f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("production_task_lines", sa.Column("program", sa.String(128), nullable=True))
    op.add_column("production_task_lines", sa.Column("instruction", sa.String(255), nullable=True))
    op.add_column("production_task_lines", sa.Column("manual_changes", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("production_task_lines", "manual_changes")
    op.drop_column("production_task_lines", "instruction")
    op.drop_column("production_task_lines", "program")
