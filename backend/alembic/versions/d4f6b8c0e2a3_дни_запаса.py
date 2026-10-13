"""Дни запаса позиции (14.10)

Revision ID: d4f6b8c0e2a3
Revises: c3e5a7b9d1f2
Create Date: 2026-10-14 10:00:00.000000

Мин. остаток от среднего расхода: дни запаса задаются вручную у позиции,
мин. остаток = средний расход за рабочий день × дни запаса.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd4f6b8c0e2a3'
down_revision: Union[str, Sequence[str], None] = 'c3e5a7b9d1f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("items", sa.Column("reserve_days", sa.Numeric(6, 1), nullable=True))


def downgrade() -> None:
    op.drop_column("items", "reserve_days")
