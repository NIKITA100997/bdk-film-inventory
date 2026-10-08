"""Нормативы у позиции номенклатуры: мин. остаток, мин. партия, кратность

Revision ID: f3b5d7e9a1c2
Revises: e2a4c6e8b0d1
Create Date: 2026-10-08 11:00:00.000000

Этап 4 пересборки: одинаковые нормативы для плёнки, п/ф и материалов —
у позиции, в её единице (плёнка — м²). Мин. остаток и партия п/ф
переносятся с детали (parts.min_stock_pieces / min_batch_pieces).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f3b5d7e9a1c2'
down_revision: Union[str, Sequence[str], None] = 'e2a4c6e8b0d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("items", sa.Column("min_stock", sa.Numeric(14, 3), nullable=True))
    op.add_column("items", sa.Column("min_batch", sa.Numeric(14, 3), nullable=True))
    op.add_column("items", sa.Column("batch_multiple", sa.Numeric(14, 3), nullable=True))
    op.execute(
        """
        UPDATE items SET min_stock = p.min_stock_pieces, min_batch = p.min_batch_pieces
        FROM parts p
        WHERE p.item_id = items.id AND (p.min_stock_pieces IS NOT NULL OR p.min_batch_pieces IS NOT NULL)
        """
    )


def downgrade() -> None:
    op.drop_column("items", "batch_multiple")
    op.drop_column("items", "min_batch")
    op.drop_column("items", "min_stock")
