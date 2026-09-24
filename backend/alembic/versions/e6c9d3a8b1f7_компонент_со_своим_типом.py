"""Единая модель: правило состава может создавать компонент со своим типом
и значениями свойств (многоуровневая конфигурируемая номенклатура: дверь →
цветная панель → сырая панель).

Revision ID: e6c9d3a8b1f7
Revises: d4a7b1c5e9f2
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e6c9d3a8b1f7"
down_revision: Union[str, Sequence[str], None] = "d4a7b1c5e9f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "item_type_components",
        sa.Column("component_type_id", sa.Integer(), sa.ForeignKey("item_types.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column("item_type_components", sa.Column("component_values", sa.JSON(), nullable=False, server_default="{}"))
    # Шаблон названия с условными частями бывает длиннее 255.
    op.alter_column("item_types", "name_template", existing_type=sa.String(255), type_=sa.String(1000))


def downgrade() -> None:
    op.alter_column("item_types", "name_template", existing_type=sa.String(1000), type_=sa.String(255))
    op.drop_column("item_type_components", "component_values")
    op.drop_column("item_type_components", "component_type_id")
