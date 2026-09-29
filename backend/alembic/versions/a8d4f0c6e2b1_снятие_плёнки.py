"""Брак окутки → «Снять плёнку»: событие партии «Снятие_плёнки» и пометка
«Ламис» в справочнике ограничений по плёнке (если её ещё нет).

Revision ID: a8d4f0c6e2b1
Revises: f6b2d8a4c1e3
"""

from typing import Sequence, Union

from alembic import op

revision: str = "a8d4f0c6e2b1"
down_revision: Union[str, Sequence[str], None] = "f6b2d8a4c1e3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE part_event_type ADD VALUE IF NOT EXISTS 'SNYATIE_PLENKI'")
    op.execute(
        "INSERT INTO part_film_restrictions (code, name, is_active) "
        "VALUES ('lamis', 'Ламис (толстые плёнки)', true) ON CONFLICT (code) DO NOTHING"
    )


def downgrade() -> None:
    # Значение enum в PostgreSQL не удаляется; пометка «Ламис» остаётся.
    pass
