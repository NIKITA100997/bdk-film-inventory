"""Линия участка в отчёте о производстве («Ежедневка» по линиям)

Revision ID: d5f7b9c1e3a4
Revises: c4e6a8b0d2f3
Create Date: 2026-10-06 15:00:00.000000

Прошлые отчёты с распределением по дням получают линию из распределения.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd5f7b9c1e3a4'
down_revision: Union[str, Sequence[str], None] = 'c4e6a8b0d2f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "production_task_line_reports",
        sa.Column("line_id", sa.Integer, sa.ForeignKey("production_lines.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("ix_production_task_line_reports_line_id", "production_task_line_reports", ["line_id"])
    op.execute("""
        UPDATE production_task_line_reports r SET line_id = a.line_id
        FROM production_task_line_assignments a
        WHERE r.assignment_id = a.id AND r.line_id IS NULL
    """)


def downgrade() -> None:
    op.drop_index("ix_production_task_line_reports_line_id", table_name="production_task_line_reports")
    op.drop_column("production_task_line_reports", "line_id")
