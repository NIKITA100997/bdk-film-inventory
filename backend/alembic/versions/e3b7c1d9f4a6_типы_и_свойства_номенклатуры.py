"""Единая модель, пункты 1–2: типы изделий внутри вида номенклатуры и их
свойства (характеристики) — список, варианты с параметрами, значения у
позиции.

Revision ID: e3b7c1d9f4a6
Revises: d7a2b9c4e1f5
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e3b7c1d9f4a6"
down_revision: Union[str, Sequence[str], None] = "d7a2b9c4e1f5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "item_types",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind_id", sa.Integer(), sa.ForeignKey("item_kinds.id"), nullable=False, index=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.UniqueConstraint("kind_id", "name", name="uq_item_types_kind_name"),
    )
    op.add_column("items", sa.Column("type_id", sa.Integer(), sa.ForeignKey("item_types.id"), nullable=True))
    op.create_index("ix_items_type_id", "items", ["type_id"])
    op.create_table(
        "item_properties",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("type_id", sa.Integer(), sa.ForeignKey("item_types.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("value_type", sa.String(16), nullable=False),
        sa.Column("unit", sa.String(16), nullable=True),
        sa.Column("is_required", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("option_fields", sa.JSON(), nullable=False, server_default="[]"),
        sa.UniqueConstraint("type_id", "code", name="uq_item_properties_type_code"),
    )
    op.create_table(
        "item_property_options",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "property_id", sa.Integer(), sa.ForeignKey("item_properties.id", ondelete="CASCADE"), nullable=False, index=True
        ),
        sa.Column("value", sa.String(128), nullable=False),
        sa.Column("params", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.UniqueConstraint("property_id", "value", name="uq_item_property_options_value"),
    )
    op.create_table(
        "item_property_values",
        sa.Column("item_id", sa.Integer(), sa.ForeignKey("items.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("property_id", sa.Integer(), sa.ForeignKey("item_properties.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("value_number", sa.Numeric(14, 4), nullable=True),
        sa.Column("value_text", sa.String(255), nullable=True),
        sa.Column("value_bool", sa.Boolean(), nullable=True),
        sa.Column("option_id", sa.Integer(), sa.ForeignKey("item_property_options.id"), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("item_property_values")
    op.drop_table("item_property_options")
    op.drop_table("item_properties")
    op.drop_index("ix_items_type_id", table_name="items")
    op.drop_column("items", "type_id")
    op.drop_table("item_types")
