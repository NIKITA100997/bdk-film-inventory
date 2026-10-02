"""Вид служебной записи отчёта (вместо разбора текста примечания)

Revision ID: c3f5b7d9e1a2
Revises: b2e4a6c8d0f1
Create Date: 2026-10-03 13:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c3f5b7d9e1a2'
down_revision: Union[str, Sequence[str], None] = 'b2e4a6c8d0f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("production_task_line_reports", sa.Column("kind", sa.String(16), nullable=True))
    op.execute("UPDATE production_task_line_reports SET kind = 'close' WHERE note LIKE 'Закрыто: сделано полностью%'")
    op.execute("UPDATE production_task_line_reports SET kind = 'recon' WHERE note LIKE 'Расход досчитан при возврате%'")
    op.execute(
        "UPDATE production_task_line_reports SET kind = 'remainder' "
        "WHERE note LIKE 'Остаток указан вручную%' AND counts_toward_line = false"
    )


def downgrade() -> None:
    op.drop_column("production_task_line_reports", "kind")
