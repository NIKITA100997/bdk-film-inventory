"""Единая модель, пункт 4: заказ на производство — позиции и количества;
запуск раскладывает заказ по маршрутам позиций на задания участкам.

Revision ID: d4a7b1c5e9f2
Revises: c3f6a9b2e8d4
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4a7b1c5e9f2"
down_revision: Union[str, Sequence[str], None] = "c3f6a9b2e8d4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "production_orders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("ship_date", sa.Date(), nullable=True),
        sa.Column("note", sa.String(500), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "production_order_lines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("production_orders.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("item_id", sa.Integer(), sa.ForeignKey("items.id"), nullable=False),
        sa.Column("quantity", sa.Numeric(12, 2), nullable=False),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "production_tasks",
        sa.Column("production_order_id", sa.Integer(), sa.ForeignKey("production_orders.id"), nullable=True),
    )
    op.create_index("ix_production_tasks_production_order_id", "production_tasks", ["production_order_id"])
    op.add_column(
        "production_task_lines",
        sa.Column("order_line_id", sa.Integer(), sa.ForeignKey("production_order_lines.id"), nullable=True),
    )
    op.create_index("ix_production_task_lines_order_line_id", "production_task_lines", ["order_line_id"])


def downgrade() -> None:
    op.drop_index("ix_production_task_lines_order_line_id", table_name="production_task_lines")
    op.drop_column("production_task_lines", "order_line_id")
    op.drop_index("ix_production_tasks_production_order_id", table_name="production_tasks")
    op.drop_column("production_tasks", "production_order_id")
    op.drop_table("production_order_lines")
    op.drop_table("production_orders")
