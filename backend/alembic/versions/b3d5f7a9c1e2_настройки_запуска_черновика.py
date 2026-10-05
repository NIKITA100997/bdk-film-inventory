"""Настройки запуска у черновика заказа (п/ф, площадки, правки, сроки)

Revision ID: b3d5f7a9c1e2
Revises: a2c4e6f8b0d1
Create Date: 2026-10-05 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b3d5f7a9c1e2'
down_revision: Union[str, Sequence[str], None] = 'a2c4e6f8b0d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("production_orders", sa.Column("release_settings", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("production_orders", "release_settings")
