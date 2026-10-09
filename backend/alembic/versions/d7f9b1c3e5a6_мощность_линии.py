"""Линия: мощность за смену

Revision ID: d7f9b1c3e5a6
Revises: c6e8a0b2d4f5
Create Date: 2026-10-09 17:00:00.000000

Аудит производительности 09.10: выработка замеряется по станку (окутка
царговых — 6 линий, Фабрика — широкоформатная и окутка погонажа).
Мощность участка — сумма активных линий, у которых она задана; иначе —
мощность самого участка, как раньше.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd7f9b1c3e5a6'
down_revision: Union[str, Sequence[str], None] = 'c6e8a0b2d4f5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("production_lines", sa.Column("capacity_per_shift", sa.Numeric(10, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("production_lines", "capacity_per_shift")
