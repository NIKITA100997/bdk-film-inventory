"""Явное завершение строки задания в производстве

Revision ID: d3f6a8e2c951
Revises: c9e1a5f7d824
Create Date: 2026-09-10 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd3f6a8e2c951'
down_revision: Union[str, Sequence[str], None] = 'c9e1a5f7d824'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Раздел про автоматический уход строк из очереди "Выдачи" + явное
    # завершение — независимая от is_closed ось: is_closed про выдачу,
    # эта колонка про то, что строку больше не предлагают для новых
    # отчётов о производстве.
    op.add_column(
        "production_task_lines",
        sa.Column("production_closed", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("production_task_lines", "production_closed")
