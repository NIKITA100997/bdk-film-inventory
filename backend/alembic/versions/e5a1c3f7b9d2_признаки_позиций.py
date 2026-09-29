"""Признаки позиций: направление, стадия (у типа и у позиции), режим.

Revision ID: e5a1c3f7b9d2
Revises: d4f8b2c6a9e1
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e5a1c3f7b9d2"
down_revision: Union[str, Sequence[str], None] = "d4f8b2c6a9e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("item_types", sa.Column("direction", sa.String(16), nullable=True))
    op.add_column("item_types", sa.Column("stage", sa.String(16), nullable=True))
    op.add_column("items", sa.Column("direction", sa.String(16), nullable=True))
    op.add_column("items", sa.Column("stage", sa.String(16), nullable=True))
    op.add_column("items", sa.Column("make_mode", sa.String(8), nullable=True))


def downgrade() -> None:
    op.drop_column("items", "make_mode")
    op.drop_column("items", "stage")
    op.drop_column("items", "direction")
    op.drop_column("item_types", "stage")
    op.drop_column("item_types", "direction")
