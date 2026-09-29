"""Сброс пароля: заявка «забыл пароль» и обязательная смена после сброса.

Revision ID: c7e2a9d4f1b3
Revises: b5d9f2a4c8e6
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c7e2a9d4f1b3"
down_revision: Union[str, Sequence[str], None] = "b5d9f2a4c8e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("must_change_password", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("users", sa.Column("password_reset_requested_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "password_reset_requested_at")
    op.drop_column("users", "must_change_password")
