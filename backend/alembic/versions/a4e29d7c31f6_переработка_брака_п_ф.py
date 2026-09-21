"""Переработка брака п/ф — резерв (В_переработку) и переработка в другую деталь

Revision ID: a4e29d7c31f6
Revises: 7299efa2d16d
Create Date: 2026-09-21 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a4e29d7c31f6'
down_revision: Union[str, Sequence[str], None] = '7299efa2d16d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ADD VALUE не может идти в одной транзакции со своим использованием —
    # тот же приём, что во всех предыдущих ADD VALUE-миграциях проекта.
    op.execute("ALTER TYPE part_unit_status ADD VALUE IF NOT EXISTS 'V_PERERABOTKU'")
    op.execute("ALTER TYPE part_event_type ADD VALUE IF NOT EXISTS 'V_PERERABOTKU'")
    op.execute("ALTER TYPE part_event_type ADD VALUE IF NOT EXISTS 'PERERABOTKA'")
    # Раздел про переработку брака — на событии "Переработка" партии-
    # источника указывает на партию, в которую она переработалась.
    op.add_column(
        "part_unit_events",
        sa.Column("related_part_unit_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_part_unit_events_related_part_unit_id",
        "part_unit_events",
        "part_units",
        ["related_part_unit_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_part_unit_events_related_part_unit_id", "part_unit_events", type_="foreignkey")
    op.drop_column("part_unit_events", "related_part_unit_id")
    # Postgres не умеет удалять одно значение enum — откат enum-а не
    # предусмотрен (тот же осознанный компромисс, что и у остальных
    # ADD VALUE-миграций в этом проекте).
