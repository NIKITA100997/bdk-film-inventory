"""попытки отправки в Битрикс24 (14.10): автоповтор неотправленного

Revision ID: d1f3b5c7e9a2
Revises: c9e1a3b5d7f8
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d1f3b5c7e9a2"
down_revision: Union[str, Sequence[str], None] = "c9e1a3b5d7f8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bitrix_outbox", sa.Column("attempts", sa.Integer, nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("bitrix_outbox", "attempts")
