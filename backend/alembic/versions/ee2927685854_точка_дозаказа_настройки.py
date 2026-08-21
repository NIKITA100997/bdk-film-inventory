"""точка дозаказа настройки

Заводит `calc_settings.reorder_lookback_days` (окно расчёта скорости
расхода, по умолчанию 30 дней) и `reorder_safety_margin_days` (запас
поверх среднего срока поставки поставщика, по умолчанию 7 дней) — см.
services/purchasing.py::compute_reorder_signal.

Revision ID: ee2927685854
Revises: ddb505124773
Create Date: 2026-08-21 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'ee2927685854'
down_revision: Union[str, Sequence[str], None] = 'ddb505124773'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "calc_settings", sa.Column("reorder_lookback_days", sa.Integer(), nullable=False, server_default="30")
    )
    op.add_column(
        "calc_settings", sa.Column("reorder_safety_margin_days", sa.Integer(), nullable=False, server_default="7")
    )


def downgrade() -> None:
    op.drop_column("calc_settings", "reorder_safety_margin_days")
    op.drop_column("calc_settings", "reorder_lookback_days")
