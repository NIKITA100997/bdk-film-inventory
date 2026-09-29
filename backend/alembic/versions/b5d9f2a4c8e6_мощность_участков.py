"""Мощность участков (задел): штук в смену и смен в день.

Revision ID: b5d9f2a4c8e6
Revises: a2c7e5f9b3d1
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b5d9f2a4c8e6"
down_revision: Union[str, Sequence[str], None] = "a2c7e5f9b3d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("areas", sa.Column("capacity_per_shift", sa.Numeric(10, 2), nullable=True))
    op.add_column("areas", sa.Column("shifts_per_day", sa.Integer(), nullable=False, server_default="1"))


def downgrade() -> None:
    op.drop_column("areas", "shifts_per_day")
    op.drop_column("areas", "capacity_per_shift")
