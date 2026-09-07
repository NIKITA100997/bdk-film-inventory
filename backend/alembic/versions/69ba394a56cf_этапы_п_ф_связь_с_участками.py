"""Этапы п/ф — связь с участками

Revision ID: 69ba394a56cf
Revises: 6b91a6666b5e
Create Date: 2026-09-07 11:55:20.117370

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '69ba394a56cf'
down_revision: Union[str, Sequence[str], None] = '6b91a6666b5e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("part_stages", sa.Column("area", sa.String(), nullable=True))
    op.create_foreign_key(None, "part_stages", "areas", ["area"], ["code"])


def downgrade() -> None:
    op.drop_constraint(None, "part_stages", type_="foreignkey")
    op.drop_column("part_stages", "area")
