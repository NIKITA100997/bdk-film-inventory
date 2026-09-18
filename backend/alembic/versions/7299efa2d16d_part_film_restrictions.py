"""part_film_restrictions

Revision ID: 7299efa2d16d
Revises: a3c8e0f21b47
Create Date: 2026-09-18 16:52:07.124986

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7299efa2d16d'
down_revision: Union[str, Sequence[str], None] = 'a3c8e0f21b47'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_SEED_RESTRICTIONS = [
    ("s_kromkoy", "С кромкой (ПЭТ 2Д/3Д)"),
    ("alyaska", "Аляска (полипропилен)"),
    ("lamis", "Ламис (толстые плёнки)"),
]


def upgrade() -> None:
    """Upgrade schema."""
    table = op.create_table(
        "part_film_restrictions",
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("code"),
        sa.UniqueConstraint("name"),
    )
    op.bulk_insert(
        table,
        [{"code": code, "name": name, "is_active": True} for code, name in _SEED_RESTRICTIONS],
    )
    op.add_column("part_units", sa.Column("film_restriction", sa.String(length=64), nullable=True))
    op.create_foreign_key(
        "part_units_film_restriction_fkey", "part_units", "part_film_restrictions", ["film_restriction"], ["code"]
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("part_units_film_restriction_fkey", "part_units", type_="foreignkey")
    op.drop_column("part_units", "film_restriction")
    op.drop_table("part_film_restrictions")
