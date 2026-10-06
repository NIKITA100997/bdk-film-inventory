"""Признак участка «остатки плёнки на склад не возвращаются»

Revision ID: a8c0e2f4b6d7
Revises: f7b9d1e3a5c6
Create Date: 2026-10-06 20:00:00.000000

Фабрика и прессы получают рулоны/штрипсы полной длины и расходуют их до
конца — склад не ждёт от них возврата, рулон отмечается «израсходован».
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a8c0e2f4b6d7'
down_revision: Union[str, Sequence[str], None] = 'f7b9d1e3a5c6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("areas", sa.Column("film_no_return", sa.Boolean(), nullable=False, server_default="false"))
    op.execute("UPDATE areas SET film_no_return = true WHERE code = 'fabrika'")


def downgrade() -> None:
    op.drop_column("areas", "film_no_return")
