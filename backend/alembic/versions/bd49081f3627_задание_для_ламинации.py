"""задание п/ф — для какой ламинации (20.10)

Revision ID: bd49081f3627
Revises: f21a73353b37
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "bd49081f3627"
down_revision: Union[str, Sequence[str], None] = "f21a73353b37"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("production_tasks", sa.Column("lam_area", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("production_tasks", "lam_area")
