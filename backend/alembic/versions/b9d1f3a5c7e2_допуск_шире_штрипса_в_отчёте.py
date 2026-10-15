"""допуск: штрипс шире нужного в отчёте (15.10)

Revision ID: b9d1f3a5c7e2
Revises: a8c0e2f4b6d9
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b9d1f3a5c7e2"
down_revision: Union[str, Sequence[str], None] = "a8c0e2f4b6d9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("calc_settings", sa.Column("report_strip_over_mm", sa.Numeric(10, 2), nullable=False, server_default="10"))


def downgrade() -> None:
    op.drop_column("calc_settings", "report_strip_over_mm")
