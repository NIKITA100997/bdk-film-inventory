"""Условие «типовой размер» у типа изделия (вместо 600–900 × 2000 в коде)

Revision ID: b2e4a6c8d0f1
Revises: a1d3f5b7c9e2
Create Date: 2026-10-03 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b2e4a6c8d0f1'
down_revision: Union[str, Sequence[str], None] = 'a1d3f5b7c9e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("item_types", sa.Column("standard_condition", sa.String(500), nullable=True))
    op.execute(
        "UPDATE item_types SET standard_condition = 'ширина in (600, 700, 800, 900) and высота == 2000' "
        "WHERE name = 'Щитовая дверь' "
        "AND EXISTS (SELECT 1 FROM item_properties p WHERE p.type_id = item_types.id AND p.code = 'ширина') "
        "AND EXISTS (SELECT 1 FROM item_properties p WHERE p.type_id = item_types.id AND p.code = 'высота')"
    )


def downgrade() -> None:
    op.drop_column("item_types", "standard_condition")
