"""Расход плёнки без готовой детали (окутка в 2 захода)

Revision ID: b7d4c2e9f316
Revises: 9d2e6f1a4c7b
Create Date: 2026-09-09 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7d4c2e9f316'
down_revision: Union[str, Sequence[str], None] = '9d2e6f1a4c7b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Раздел про окутку в 2 захода — отличает промежуточный переход
    # партии п/ф (деталь физически ещё не готова) от завершающего:
    # существующие отчёты все получают True (сохраняют текущий подсчитанный
    # остаток по всей истории — раньше промежуточных этапов не было).
    op.add_column(
        "production_task_line_reports",
        sa.Column("counts_toward_line", sa.Boolean(), nullable=False, server_default="true"),
    )


def downgrade() -> None:
    op.drop_column("production_task_line_reports", "counts_toward_line")
