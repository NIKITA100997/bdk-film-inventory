"""Состав исходных позиций у строк заданий участков.

Revision ID: a4c8e2f6b0d1
Revises: e2b4d6f8a0c1
Create Date: 2026-11-05
"""

from alembic import op
import sqlalchemy as sa


revision = "a4c8e2f6b0d1"
down_revision = "e2b4d6f8a0c1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "production_task_line_sources",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("task_line_id", sa.Integer(), nullable=False),
        sa.Column("order_line_id", sa.Integer(), nullable=False),
        sa.Column("quantity_pieces", sa.Numeric(12, 2), nullable=False),
        sa.ForeignKeyConstraint(["task_line_id"], ["production_task_lines.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["order_line_id"], ["production_order_lines.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_line_id", "order_line_id"),
    )
    op.create_index(
        "ix_production_task_line_sources_task_line_id",
        "production_task_line_sources",
        ["task_line_id"],
    )
    op.create_index(
        "ix_production_task_line_sources_order_line_id",
        "production_task_line_sources",
        ["order_line_id"],
    )
    op.execute(sa.text("""
        INSERT INTO production_task_line_sources (task_line_id, order_line_id, quantity_pieces)
        SELECT id, order_line_id, quantity_pieces
        FROM production_task_lines
        WHERE order_line_id IS NOT NULL
    """))


def downgrade() -> None:
    op.drop_index("ix_production_task_line_sources_order_line_id", table_name="production_task_line_sources")
    op.drop_index("ix_production_task_line_sources_task_line_id", table_name="production_task_line_sources")
    op.drop_table("production_task_line_sources")
