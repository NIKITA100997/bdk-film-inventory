"""Признак участка «по строкам не отчитываются» (вместо кода Фабрики во фронте)

Revision ID: d4a6c8e0f2b3
Revises: c3f5b7d9e1a2
Create Date: 2026-10-03 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd4a6c8e0f2b3'
down_revision: Union[str, Sequence[str], None] = 'c3f5b7d9e1a2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("areas", sa.Column("close_without_reports", sa.Boolean(), nullable=False, server_default="false"))
    op.execute("UPDATE areas SET close_without_reports = true WHERE code = 'fabrika'")


def downgrade() -> None:
    op.drop_column("areas", "close_without_reports")
