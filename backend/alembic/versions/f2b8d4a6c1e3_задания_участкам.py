"""Задания участкам (без плёнки, для любого участка)

Revision ID: f2b8d4a6c1e3
Revises: e5a1c7f3b920
Create Date: 2026-09-23 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f2b8d4a6c1e3'
down_revision: Union[str, Sequence[str], None] = 'e5a1c7f3b920'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "area_tasks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("area", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False, server_default="manual"),
        sa.Column("ship_date", sa.Date(), nullable=True),
        sa.Column("note", sa.String(length=255), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["area"], ["areas.code"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_area_tasks_area"), "area_tasks", ["area"])
    op.create_table(
        "area_task_lines",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("task_id", sa.Integer(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("quantity_pieces", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("part_stage_id", sa.Integer(), nullable=True),
        sa.Column("note", sa.String(length=255), nullable=True),
        sa.ForeignKeyConstraint(["task_id"], ["area_tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["part_stage_id"], ["part_stages.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_area_task_lines_task_id"), "area_task_lines", ["task_id"])
    op.create_table(
        "area_task_reports",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("line_id", sa.Integer(), nullable=False),
        sa.Column("good_pieces", sa.Numeric(precision=12, scale=2), nullable=False, server_default="0"),
        sa.Column("defect_pieces", sa.Numeric(precision=12, scale=2), nullable=False, server_default="0"),
        sa.Column("defect_reason", sa.String(length=64), nullable=True),
        sa.Column("note", sa.String(length=255), nullable=True),
        sa.Column("reported_by", sa.Integer(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["line_id"], ["area_task_lines.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["defect_reason"], ["write_off_reasons.code"]),
        sa.ForeignKeyConstraint(["reported_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_area_task_reports_line_id"), "area_task_reports", ["line_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_area_task_reports_line_id"), table_name="area_task_reports")
    op.drop_table("area_task_reports")
    op.drop_index(op.f("ix_area_task_lines_task_id"), table_name="area_task_lines")
    op.drop_table("area_task_lines")
    op.drop_index(op.f("ix_area_tasks_area"), table_name="area_tasks")
    op.drop_table("area_tasks")
