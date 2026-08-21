"""справочник сотрудники

Заводит `employees` (id, name unique, is_active) — по образцу `colors`/
`materials`. Автокомплит вместо голого текста в
ProductionTaskLineAssignment.employee_names (не FK — поле остаётся
свободным текстом с несколькими именами через запятую, справочник только
подсказывает варианты и подсвечивает похожие написания).

Revision ID: ddb505124773
Revises: 0dd31938f357
Create Date: 2026-08-21 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'ddb505124773'
down_revision: Union[str, Sequence[str], None] = '0dd31938f357'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "employees",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )


def downgrade() -> None:
    op.drop_table("employees")
