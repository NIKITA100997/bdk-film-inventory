"""Операция маршрута типа без участка — «Готово», общий запас (последняя).

Revision ID: b3d8e1f5a2c4
Revises: a7e2c9f4b6d1
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b3d8e1f5a2c4"
down_revision: Union[str, Sequence[str], None] = "a7e2c9f4b6d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("item_type_operations", "area", existing_type=sa.String(), nullable=True)


def downgrade() -> None:
    op.alter_column("item_type_operations", "area", existing_type=sa.String(), nullable=False)
