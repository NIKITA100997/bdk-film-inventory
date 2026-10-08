"""Цена м² у рулона/штрипса и сумма у движения плёнки

Revision ID: a4c6e8f0b2d3
Revises: f3b5d7e9a1c2
Create Date: 2026-10-08 13:00:00.000000

Учёт по количеству и сумме (08.10, шаг 1а): рулон получает цену м² при
приходе, куски наследуют её; каждое движение хранит сумму в рублях.
Старые рулоны и движения заполняет scripts/backfill_lot_prices.py.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a4c6e8f0b2d3'
down_revision: Union[str, Sequence[str], None] = 'f3b5d7e9a1c2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("material_units", sa.Column("price_per_m2", sa.Numeric(12, 4), nullable=True))
    op.add_column("material_units", sa.Column("price_source", sa.String(16), nullable=True))
    op.add_column("material_events", sa.Column("amount_rub", sa.Numeric(14, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("material_events", "amount_rub")
    op.drop_column("material_units", "price_source")
    op.drop_column("material_units", "price_per_m2")
