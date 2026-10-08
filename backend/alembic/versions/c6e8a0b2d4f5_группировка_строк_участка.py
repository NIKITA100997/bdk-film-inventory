"""Участок: по каким признакам объединять строки заданий

Revision ID: c6e8a0b2d4f5
Revises: b5d7f9a1c3e4
Create Date: 2026-10-08 18:00:00.000000

Строки дверей остаются по строкам заказа (ход заказа, склад готовой по
счёту), а участок видит и отчитывается по группам — серия, размер, цвет,
кромка, замок… (services/line_groups.py). Пусто — без группировки.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c6e8a0b2d4f5'
down_revision: Union[str, Sequence[str], None] = 'b5d7f9a1c3e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("areas", sa.Column("group_props", sa.JSON, nullable=True))


def downgrade() -> None:
    op.drop_column("areas", "group_props")
