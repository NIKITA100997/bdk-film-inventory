"""Причина списания "Списано по заданию" — авто-списание готовых п/ф по плану строки задания

Revision ID: d3f7a2c9e1b4
Revises: a4e29d7c31f6
Create Date: 2026-09-23 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd3f7a2c9e1b4'
down_revision: Union[str, Sequence[str], None] = 'a4e29d7c31f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


write_off_reasons_table = sa.table(
    "write_off_reasons",
    sa.column("code", sa.String),
    sa.column("name", sa.String),
    sa.column("is_active", sa.Boolean),
    sa.column("is_system", sa.Boolean),
    sa.column("category", sa.String),
)

# Раздел про списание готовых п/ф по заданию окутки/ламинации — эта
# причина, как и "Отход при раскрое" (см. 119fbe243271), проставляется
# только системой (_build_task_line_report при is_final=True), is_system
# скрывает её из формы ручного списания — там она была бы бессмысленна.
CODE = "spisano_po_zadaniyu"


def upgrade() -> None:
    op.execute(
        write_off_reasons_table.insert().values(
            code=CODE, name="Списано по заданию", is_active=True, is_system=True, category="parts"
        )
    )


def downgrade() -> None:
    op.execute(write_off_reasons_table.delete().where(write_off_reasons_table.c.code == CODE))
