"""обещанная дата поставки

Заводит `purchase_requests.promised_delivery_date` (nullable date) —
план поставщика, сравнивается с фактическим closed_at при закрытии
заявки (см. services/suppliers.py::compute_supplier_stats).

Revision ID: 0dd31938f357
Revises: 1193c38c9e8f
Create Date: 2026-08-21 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0dd31938f357'
down_revision: Union[str, Sequence[str], None] = '1193c38c9e8f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("purchase_requests", sa.Column("promised_delivery_date", sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column("purchase_requests", "promised_delivery_date")
