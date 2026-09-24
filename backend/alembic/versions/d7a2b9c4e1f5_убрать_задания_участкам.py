"""Убрать «Задания участкам» — влились в «Задания цеха» (задание на любой
участок, строка-операция). На проде таблицы пустые; если нет — миграция
останавливается, а не теряет данные.

Revision ID: d7a2b9c4e1f5
Revises: c6f1a3e8d2b4
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d7a2b9c4e1f5"
down_revision: Union[str, Sequence[str], None] = "c6f1a3e8d2b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    n = op.get_bind().execute(sa.text("SELECT count(*) FROM area_tasks")).scalar()
    if n:
        raise RuntimeError(f"В area_tasks {n} заданий — перенесите их в «Задания цеха» до удаления таблиц")
    op.drop_table("area_task_reports")
    op.drop_table("area_task_lines")
    op.drop_table("area_tasks")


def downgrade() -> None:
    op.create_table(
        "area_tasks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("area", sa.String(128), sa.ForeignKey("areas.code"), nullable=False, index=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("ship_date", sa.Date(), nullable=True),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "area_task_lines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("task_id", sa.Integer(), sa.ForeignKey("area_tasks.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("quantity_pieces", sa.Numeric(12, 2), nullable=False),
        sa.Column("part_stage_id", sa.Integer(), sa.ForeignKey("part_stages.id"), nullable=True),
        sa.Column("note", sa.String(255), nullable=True),
    )
    op.create_table(
        "area_task_reports",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("line_id", sa.Integer(), sa.ForeignKey("area_task_lines.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("good_pieces", sa.Numeric(12, 2), nullable=False),
        sa.Column("defect_pieces", sa.Numeric(12, 2), nullable=False),
        sa.Column("defect_reason", sa.String(64), sa.ForeignKey("write_off_reasons.code"), nullable=True),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("reported_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
