"""Сопоставления плёнки: текст из внешних источников → плёнка справочника

Revision ID: c9f4a1b2d3e5
Revises: b8e3f1a2c4d6
Create Date: 2026-10-02 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c9f4a1b2d3e5'
down_revision: Union[str, Sequence[str], None] = 'b8e3f1a2c4d6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "film_aliases",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("text", sa.String(255), nullable=False),
        sa.Column("key", sa.String(255), nullable=False),
        sa.Column("material_id", sa.Integer(), sa.ForeignKey("materials.id"), nullable=False),
        sa.Column("color_id", sa.Integer(), sa.ForeignKey("colors.id"), nullable=False),
        sa.Column("thickness_id", sa.Integer(), sa.ForeignKey("thicknesses.id"), nullable=True),
        sa.Column("source", sa.String(64), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_film_aliases_key", "film_aliases", ["key"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_film_aliases_key", table_name="film_aliases")
    op.drop_table("film_aliases")
