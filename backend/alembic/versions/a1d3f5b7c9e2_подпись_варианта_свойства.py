"""Подпись варианта свойства (вместо словаря abs→ABS в коде)

Revision ID: a1d3f5b7c9e2
Revises: f4c7d9e1a3b5
Create Date: 2026-10-03 11:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1d3f5b7c9e2'
down_revision: Union[str, Sequence[str], None] = 'f4c7d9e1a3b5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("item_property_options", sa.Column("label", sa.String(128), nullable=True))
    op.execute("UPDATE item_property_options SET label = 'ABS' WHERE value = 'abs'")
    op.execute("UPDATE item_property_options SET label = 'алюминий' WHERE value = 'aluminum'")


def downgrade() -> None:
    op.drop_column("item_property_options", "label")
