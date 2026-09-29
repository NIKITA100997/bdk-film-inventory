"""Вид заказа на производство: клиенту или на склад (пополнение остатка).

Revision ID: b9e5a1d7c3f2
Revises: a8d4f0c6e2b1
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b9e5a1d7c3f2"
down_revision: Union[str, Sequence[str], None] = "a8d4f0c6e2b1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("production_orders", sa.Column("kind", sa.String(16), nullable=False, server_default="customer"))


def downgrade() -> None:
    op.drop_column("production_orders", "kind")
