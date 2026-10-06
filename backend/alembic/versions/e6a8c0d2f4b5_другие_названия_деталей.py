"""Другие названия деталей (синонимы из нарядов, графиков, 1С)

Revision ID: e6a8c0d2f4b5
Revises: d5f7b9c1e3a4
Create Date: 2026-10-06 17:00:00.000000

Ручная связка строк без детали запоминает текст как другое название
детали — следующие строки с этим текстом связываются сами.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e6a8c0d2f4b5'
down_revision: Union[str, Sequence[str], None] = 'd5f7b9c1e3a4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "part_aliases",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("alias", sa.String(255), nullable=False, unique=True),
        sa.Column("part_id", sa.Integer, sa.ForeignKey("parts.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("part_aliases")
