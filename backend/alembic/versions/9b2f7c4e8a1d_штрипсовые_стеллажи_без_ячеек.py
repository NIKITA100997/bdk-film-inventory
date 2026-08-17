"""Штрипсовые стеллажи без ячеек

Revision ID: 9b2f7c4e8a1d
Revises: 3f8b6e1a9c2d
Create Date: 2026-08-17 00:00:00.000002

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9b2f7c4e8a1d'
down_revision: Union[str, Sequence[str], None] = '3f8b6e1a9c2d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('racks', sa.Column('strip_capacity', sa.Integer(), nullable=True))
    op.drop_column('calc_settings', 'cells_per_strip_shelf')


def downgrade() -> None:
    """Downgrade schema."""
    op.add_column('calc_settings', sa.Column('cells_per_strip_shelf', sa.Integer(), nullable=False, server_default='10'))
    op.drop_column('racks', 'strip_capacity')
