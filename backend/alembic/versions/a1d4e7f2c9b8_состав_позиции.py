"""Единая модель, пункт 3: состав позиции (спецификация) для любого вида
номенклатуры. Связанные с деталью строки BOM моделей переносятся в состав
(source='bom').

Revision ID: a1d4e7f2c9b8
Revises: f5c8d2e1a7b3
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a1d4e7f2c9b8"
down_revision: Union[str, Sequence[str], None] = "f5c8d2e1a7b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "item_components",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("parent_item_id", sa.Integer(), sa.ForeignKey("items.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("component_item_id", sa.Integer(), sa.ForeignKey("items.id"), nullable=False, index=True),
        sa.Column("qty_per_unit", sa.Numeric(12, 4), nullable=False),
        sa.Column("stage_id", sa.Integer(), sa.ForeignKey("part_stages.id", ondelete="SET NULL"), nullable=True),
        sa.Column("source", sa.String(16), nullable=False, server_default="manual"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
    )
    # Перенос связанных строк BOM: компонент — позиция детали, количество —
    # сумма по строкам модели с этой деталью.
    op.execute(
        """
        INSERT INTO item_components (parent_item_id, component_item_id, qty_per_unit, source, sort_order)
        SELECT m.item_id, p.item_id, SUM(b.qty_per_unit), 'bom', MIN(b.id)
        FROM product_model_parts b
        JOIN product_models m ON m.id = b.product_model_id
        JOIN parts p ON p.id = b.part_id
        WHERE m.item_id IS NOT NULL AND p.item_id IS NOT NULL
        GROUP BY m.item_id, p.item_id
        """
    )


def downgrade() -> None:
    op.drop_table("item_components")
