"""Единая модель, пункт 5: участок как рабочий центр с настройками —
«рулон обязателен в отчёте» становится галочкой участка вместо хардкода
одного кода участка. Включается там, где правило работало (окутка
царговых), поведение не меняется.

Revision ID: c3f6a9b2e8d4
Revises: b2e5f8a3d6c1
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c3f6a9b2e8d4"
down_revision: Union[str, Sequence[str], None] = "b2e5f8a3d6c1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "areas", sa.Column("requires_roll_on_report", sa.Boolean(), nullable=False, server_default="false")
    )
    op.execute("UPDATE areas SET requires_roll_on_report = true WHERE code = 'okutka_tsargovykh'")


def downgrade() -> None:
    op.drop_column("areas", "requires_roll_on_report")
