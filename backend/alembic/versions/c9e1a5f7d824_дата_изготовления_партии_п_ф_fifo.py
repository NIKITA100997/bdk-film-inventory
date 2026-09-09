"""Дата изготовления партии п/ф (учёт по FIFO)

Revision ID: c9e1a5f7d824
Revises: b7d4c2e9f316
Create Date: 2026-09-09 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9e1a5f7d824'
down_revision: Union[str, Sequence[str], None] = 'b7d4c2e9f316'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Раздел про учёт п/ф по FIFO — дата, по которой партия расходуется
    # (не дата записи в систему). Существующие партии получают текущую
    # дату (по факту дату добавления в систему, как решили).
    op.add_column(
        "part_units",
        sa.Column("manufactured_at", sa.Date(), nullable=False, server_default=sa.text("CURRENT_DATE")),
    )


def downgrade() -> None:
    op.drop_column("part_units", "manufactured_at")
