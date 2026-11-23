"""add_pet_film_restriction

Revision ID: c1f9a8d2e3b4
Revises: 2ca23912ef0d
Create Date: 2026-11-23 14:52:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'c1f9a8d2e3b4'
down_revision: Union[str, Sequence[str], None] = '2ca23912ef0d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "INSERT INTO part_film_restrictions (code, name, is_active) "
        "VALUES ('pet', 'ПЭТ', true) ON CONFLICT (code) DO NOTHING"
    )


def downgrade() -> None:
    pass
