"""Закрытие строки задания по выдаче

Revision ID: 7c3f9a1e2b4d
Revises: 506428647b77
Create Date: 2026-09-08 13:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7c3f9a1e2b4d'
down_revision: Union[str, Sequence[str], None] = '506428647b77'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Раздел про закрытие строки задания по выдаче — та же механика, что
    # ProductionTask.is_active, но на уровень ниже: одна строка задания
    # (не всё задание целиком) помечается "выдача закрыта, больше ничего
    # не ожидается" вручную, поверх реальных (в т.ч. недостоверных
    # исторических) цифр, без их подгонки под ноль.
    op.add_column(
        "production_task_lines",
        sa.Column("is_closed", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("production_task_lines", "is_closed")
