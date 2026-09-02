"""участок без разбивки по дням

Revision ID: 5e87eb25bd54
Revises: d4e8f2a6c9b1
Create Date: 2026-09-02 16:27:10.566949

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '5e87eb25bd54'
down_revision: Union[str, Sequence[str], None] = 'd4e8f2a6c9b1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "areas",
        sa.Column("requires_daily_plan", sa.Boolean(), nullable=False, server_default="true"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("areas", "requires_daily_plan")
