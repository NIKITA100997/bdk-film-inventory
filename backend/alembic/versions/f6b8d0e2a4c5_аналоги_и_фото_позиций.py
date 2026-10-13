"""Аналоги и фото любой позиции (14.10)

У плёнки они уже были (sku_analogs, material_skus.photo_path); теперь то же
для детали п/ф, материала, изделия: фото позиции и ручные пары «аналог».
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f6b8d0e2a4c5'
down_revision: Union[str, Sequence[str], None] = 'e5a7c9d1f3b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("items", sa.Column("photo_path", sa.String(255), nullable=True))
    op.create_table(
        "item_analogs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("item_id", sa.Integer, sa.ForeignKey("items.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("analog_item_id", sa.Integer, sa.ForeignKey("items.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("item_id", "analog_item_id", name="uq_item_analog_pair"),
    )


def downgrade() -> None:
    op.drop_table("item_analogs")
    op.drop_column("items", "photo_path")
