"""Состав позиции: альтернативы («или») и компонент только из брака.

Revision ID: c3a7e9b1d5f4
Revises: b9e5a1d7c3f2
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c3a7e9b1d5f4"
down_revision: Union[str, Sequence[str], None] = "b9e5a1d7c3f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("item_components", sa.Column("alt_group", sa.Integer(), nullable=True))
    op.add_column("item_components", sa.Column("from_defect", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("item_components", "from_defect")
    op.drop_column("item_components", "alt_group")
