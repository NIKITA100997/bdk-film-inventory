"""Пометка старого задания на единице

Revision ID: 506428647b77
Revises: bc662948f97c
Create Date: 2026-09-08 11:40:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '506428647b77'
down_revision: Union[str, Sequence[str], None] = 'bc662948f97c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Раздел про сверку рулонов на окутке — рулон выдан/возвращён по
    # реальному, бумажному заданию, которого нет в системе: свободный текст
    # вместо привязки к production_task_line_id (не заводим фиктивные строки
    # заданий ради одной пометки).
    op.add_column("material_units", sa.Column("legacy_task_note", sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column("material_units", "legacy_task_note")
