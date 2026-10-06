"""Основной склад готовой продукции у площадки + перемещение изделий

Revision ID: c0e2a4b6d8f9
Revises: b9d1f3a5c7e8
Create Date: 2026-10-06 22:00:00.000000

06.10: все готовые двери в итоге едут на Северный, Фабрика — перевалочная
база. Признак ставится Северному, если площадка с таким названием есть.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c0e2a4b6d8f9'
down_revision: Union[str, Sequence[str], None] = 'b9d1f3a5c7e8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sites", sa.Column("is_fg_main", sa.Boolean(), nullable=False, server_default="false"))
    op.execute("UPDATE sites SET is_fg_main = true WHERE name = 'Северный'")


def downgrade() -> None:
    op.drop_column("sites", "is_fg_main")
