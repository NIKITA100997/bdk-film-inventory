"""Единая модель, пункт 3: правила типа изделия — шаблон названия позиции,
операции маршрута с условиями, правила состава с формулами.

Revision ID: b2e5f8a3d6c1
Revises: a1d4e7f2c9b8
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b2e5f8a3d6c1"
down_revision: Union[str, Sequence[str], None] = "a1d4e7f2c9b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("item_types", sa.Column("name_template", sa.String(255), nullable=True))
    op.create_table(
        "item_type_operations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("type_id", sa.Integer(), sa.ForeignKey("item_types.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("sequence_order", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("area", sa.String(128), sa.ForeignKey("areas.code"), nullable=False),
        sa.Column("condition", sa.String(500), nullable=True),
    )
    op.create_table(
        "item_type_components",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("type_id", sa.Integer(), sa.ForeignKey("item_types.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("name_template", sa.String(255), nullable=False),
        sa.Column("qty_expr", sa.String(255), nullable=False, server_default="1"),
        sa.Column("condition", sa.String(500), nullable=True),
        sa.Column("width_expr", sa.String(255), nullable=True),
        sa.Column("length_expr", sa.String(255), nullable=True),
        sa.Column("strip_width_expr", sa.String(255), nullable=True),
        sa.Column("route_part_id", sa.Integer(), sa.ForeignKey("parts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("operation_name", sa.String(255), nullable=True),
    )
    op.add_column(
        "item_components",
        sa.Column("rule_id", sa.Integer(), sa.ForeignKey("item_type_components.id", ondelete="SET NULL"), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("item_components", "rule_id")
    op.drop_table("item_type_components")
    op.drop_table("item_type_operations")
    op.drop_column("item_types", "name_template")
