"""Минимальный остаток и минимальная партия производства детали п/ф

Revision ID: a7c3e9b1d5f2
Revises: f2b8d4a6c1e3
Create Date: 2026-09-23 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7c3e9b1d5f2'
down_revision: Union[str, Sequence[str], None] = 'f2b8d4a6c1e3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("parts", sa.Column("min_stock_pieces", sa.Numeric(precision=12, scale=2), nullable=True))
    op.add_column("parts", sa.Column("min_batch_pieces", sa.Numeric(precision=12, scale=2), nullable=True))


def downgrade() -> None:
    op.drop_column("parts", "min_batch_pieces")
    op.drop_column("parts", "min_stock_pieces")
