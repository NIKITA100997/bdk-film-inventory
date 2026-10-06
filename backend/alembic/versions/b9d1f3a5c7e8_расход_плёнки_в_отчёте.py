"""Фактический расход плёнки в отчёте (прессы: штуки + метры)

Revision ID: b9d1f3a5c7e8
Revises: a8c0e2f4b6d7
Create Date: 2026-10-06 21:00:00.000000

Мастер пресса вводит, сколько метров плёнки ушло; расход рулона и средний
расход на панель считаются по нему, а не по норме «длина детали × штуки».
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b9d1f3a5c7e8'
down_revision: Union[str, Sequence[str], None] = 'a8c0e2f4b6d7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("production_task_line_reports", sa.Column("film_used_m", sa.Numeric(12, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("production_task_line_reports", "film_used_m")
