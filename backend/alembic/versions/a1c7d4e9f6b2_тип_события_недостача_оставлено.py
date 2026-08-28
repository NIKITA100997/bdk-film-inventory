"""тип события недостача оставлено

Revision ID: a1c7d4e9f6b2
Revises: b7c9d1e3f2a4
Create Date: 2026-08-28 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1c7d4e9f6b2'
down_revision: Union[str, Sequence[str], None] = 'b7c9d1e3f2a4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute("ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'INVENTARIZATSIYA_NEDOSTACHA_OSTAVLENO'")


def downgrade() -> None:
    """Downgrade schema."""
    pass
