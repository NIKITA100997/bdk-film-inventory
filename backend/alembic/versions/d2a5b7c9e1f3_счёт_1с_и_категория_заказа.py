"""Счёт 1С у строки заказа, категория заказа (справочник)

Revision ID: d2a5b7c9e1f3
Revises: c9f4a1b2d3e5
Create Date: 2026-10-02 20:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd2a5b7c9e1f3'
down_revision: Union[str, Sequence[str], None] = 'c9f4a1b2d3e5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "order_categories",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(128), nullable=False, unique=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
    )
    op.add_column("production_orders", sa.Column("category_id", sa.Integer(), sa.ForeignKey("order_categories.id"), nullable=True))
    op.add_column("production_order_lines", sa.Column("invoice_no", sa.String(64), nullable=True))
    op.create_index("ix_production_order_lines_invoice_no", "production_order_lines", ["invoice_no"])
    # Строки из графика писали счёт в примечание: «счёт 1726-ВД; 16.09».
    op.execute(r"""
        UPDATE production_order_lines
        SET invoice_no = trim(substring(note from '^счёт ([^;]+)')),
            note = nullif(trim(regexp_replace(note, '^счёт [^;]+;?\s*', '')), '')
        WHERE note ~ '^счёт '
    """)


def downgrade() -> None:
    op.drop_index("ix_production_order_lines_invoice_no", table_name="production_order_lines")
    op.drop_column("production_order_lines", "invoice_no")
    op.drop_column("production_orders", "category_id")
    op.drop_table("order_categories")
