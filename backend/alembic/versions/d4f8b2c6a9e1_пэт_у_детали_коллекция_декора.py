"""ПЭТ 2Д/3Д у детали и коллекция у декора (цвета плёнки).

items.pet_type: какой ПЭТ идёт на деталь, если декор ПЭТ; NULL — 2Д (основа).
colors.collection: коллекция декоров («Ламис» — ими переклеивают деталь
после снятия плёнки).

Revision ID: d4f8b2c6a9e1
Revises: c7e2a9d4f1b3
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4f8b2c6a9e1"
down_revision: Union[str, Sequence[str], None] = "c7e2a9d4f1b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("items", sa.Column("pet_type", sa.String(2), nullable=True))
    op.add_column("colors", sa.Column("collection", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("colors", "collection")
    op.drop_column("items", "pet_type")
