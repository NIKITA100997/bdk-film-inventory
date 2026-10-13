"""Синонимы любой позиции (14.10)

Revision ID: e5a7c9d1f3b4
Revises: d4f6b8c0e2a3
Create Date: 2026-10-14 12:00:00.000000

part_aliases (другие названия деталей) → item_aliases: то же для любой
позиции номенклатуры (материал, изделие, плёнка, п/ф). Синонимы деталей
переносятся на их позиции номенклатуры.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e5a7c9d1f3b4'
down_revision: Union[str, Sequence[str], None] = 'd4f6b8c0e2a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "item_aliases",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("alias", sa.String(255), nullable=False, unique=True),
        sa.Column("text", sa.String(255), nullable=False),
        sa.Column("item_id", sa.Integer, sa.ForeignKey("items.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("source", sa.String(64), nullable=True),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.execute("""
        insert into item_aliases (alias, text, item_id, source, created_by, created_at)
        select a.alias, a.alias, p.item_id, 'связка строк', a.created_by, a.created_at
        from part_aliases a join parts p on p.id = a.part_id
        where p.item_id is not null
    """)
    op.drop_table("part_aliases")


def downgrade() -> None:
    op.create_table(
        "part_aliases",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("alias", sa.String(255), nullable=False, unique=True),
        sa.Column("part_id", sa.Integer, sa.ForeignKey("parts.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.execute("""
        insert into part_aliases (alias, part_id, created_by, created_at)
        select a.alias, p.id, a.created_by, a.created_at
        from item_aliases a join parts p on p.item_id = a.item_id
    """)
    op.drop_table("item_aliases")
