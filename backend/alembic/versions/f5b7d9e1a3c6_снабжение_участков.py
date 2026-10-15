"""снабжение участков: заявки, неснижаемый остаток, участок выдачи плёнки и станок резки (15.10)

Revision ID: f5b7d9e1a3c6
Revises: e3a5c7d9f1b4
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f5b7d9e1a3c6"
down_revision: Union[str, Sequence[str], None] = "e3a5c7d9f1b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "area_requests",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("area", sa.String(128), sa.ForeignKey("areas.code"), nullable=False, index=True),
        sa.Column("item_id", sa.Integer, sa.ForeignKey("items.id"), nullable=True, index=True),
        sa.Column("what", sa.String(255), nullable=True),
        sa.Column("qty", sa.Numeric(14, 3), nullable=True),
        sa.Column("unit", sa.String(16), nullable=True),
        sa.Column("width_mm", sa.Numeric(10, 2), nullable=True),
        sa.Column("needed_by", sa.Date, nullable=True),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="new", index=True),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("closed_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("close_note", sa.String(255), nullable=True),
    )
    op.create_table(
        "area_stock_norms",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("area", sa.String(128), sa.ForeignKey("areas.code"), nullable=False, index=True),
        sa.Column("item_id", sa.Integer, sa.ForeignKey("items.id"), nullable=False),
        sa.Column("min_qty", sa.Numeric(14, 3), nullable=False),
        sa.Column("updated_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("area", "item_id", name="uq_area_stock_norm"),
    )
    op.add_column("areas", sa.Column("film_issue_point", sa.Boolean, nullable=False, server_default="false"))
    op.add_column("cutting_operations", sa.Column("line_id", sa.Integer, sa.ForeignKey("production_lines.id", ondelete="SET NULL"), nullable=True))
    op.create_index("ix_cutting_operations_line_id", "cutting_operations", ["line_id"])


def downgrade() -> None:
    op.drop_index("ix_cutting_operations_line_id", "cutting_operations")
    op.drop_column("cutting_operations", "line_id")
    op.drop_column("areas", "film_issue_point")
    op.drop_table("area_stock_norms")
    op.drop_table("area_requests")
