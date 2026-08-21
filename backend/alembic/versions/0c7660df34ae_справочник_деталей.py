"""справочник деталей

Заводит `parts` (id, name unique, width_mm, length_m, strip_width_mm
nullable, is_active) — по образцу `employees`. Источник подсказки для
автозаполнения формы при создании строки BOM/задания, не FK-связь.

Revision ID: 0c7660df34ae
Revises: 99d2d517f37f
Create Date: 2026-08-21 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0c7660df34ae'
down_revision: Union[str, Sequence[str], None] = '99d2d517f37f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "parts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("width_mm", sa.Numeric(10, 2), nullable=False),
        sa.Column("length_m", sa.Numeric(12, 3), nullable=False),
        sa.Column("strip_width_mm", sa.Numeric(10, 2), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )


def downgrade() -> None:
    op.drop_table("parts")
