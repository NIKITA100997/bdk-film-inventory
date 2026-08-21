"""номер заказа отдельным полем

Заводит `production_tasks.external_order_ref` (nullable int) — номер заказа
из наряда отдельно от `name`, где он остаётся частью человекочитаемого
ярлыка. Нужен для поиска/группировки заданий по одному заказу и как точка
стыковки с 1С.

Revision ID: 1193c38c9e8f
Revises: a1b2c3d4e5f6
Create Date: 2026-08-21 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '1193c38c9e8f'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("production_tasks", sa.Column("external_order_ref", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("production_tasks", "external_order_ref")
