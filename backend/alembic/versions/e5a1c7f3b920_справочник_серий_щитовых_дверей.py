"""Справочник серий щитовых дверей

Revision ID: e5a1c7f3b920
Revises: d3f7a2c9e1b4
Create Date: 2026-09-23 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e5a1c7f3b920'
down_revision: Union[str, Sequence[str], None] = 'd3f7a2c9e1b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "door_series",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("frame_thickness_mm", sa.Numeric(precision=6, scale=2), nullable=False),
        sa.Column("panel_mdf_thickness_mm", sa.Numeric(precision=6, scale=2), nullable=False),
        sa.Column("edge_type", sa.String(length=16), nullable=False),
        sa.Column("has_glass", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("has_moulding", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("needs_lock_milling", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("milling_program", sa.String(length=128), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
        sa.CheckConstraint("edge_type IN ('abs', 'aluminum')", name="ck_door_series_edge_type"),
    )


def downgrade() -> None:
    op.drop_table("door_series")
