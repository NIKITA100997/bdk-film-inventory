"""Оплата работ: вид оплаты и ставки участка, сдельная расценка операции

Revision ID: a2c4e6f8b0d1
Revises: f6c8e0a2b4d5
Create Date: 2026-10-05 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a2c4e6f8b0d1'
down_revision: Union[str, Sequence[str], None] = 'f6c8e0a2b4d5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("areas", sa.Column("pay_mode", sa.String(8), nullable=True))
    op.add_column("areas", sa.Column("piece_rate", sa.Numeric(12, 4), nullable=True))
    op.add_column("areas", sa.Column("shift_rate", sa.Numeric(12, 2), nullable=True))
    op.add_column("areas", sa.Column("shift_headcount", sa.Numeric(6, 2), nullable=True))
    op.add_column("item_type_operations", sa.Column("piece_rate_expr", sa.String(255), nullable=True))
    op.add_column("part_stages", sa.Column("piece_rate", sa.Numeric(12, 4), nullable=True))


def downgrade() -> None:
    op.drop_column("part_stages", "piece_rate")
    op.drop_column("item_type_operations", "piece_rate_expr")
    for c in ("shift_headcount", "shift_rate", "piece_rate", "pay_mode"):
        op.drop_column("areas", c)
