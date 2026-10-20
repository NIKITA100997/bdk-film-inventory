"""программы фрезеровки, привязанные к изделию (20.10)

Revision ID: 132f74e8da83
Revises: bd49081f3627
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "132f74e8da83"
down_revision: Union[str, Sequence[str], None] = "bd49081f3627"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("items", sa.Column("milling_programs", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("items", "milling_programs")
