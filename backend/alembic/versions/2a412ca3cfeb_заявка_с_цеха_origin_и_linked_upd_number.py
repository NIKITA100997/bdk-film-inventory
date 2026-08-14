"""заявка с цеха origin и linked upd number

Revision ID: 2a412ca3cfeb
Revises: a9dcb07dac18
Create Date: 2026-08-14 11:13:36.137308

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2a412ca3cfeb'
down_revision: Union[str, Sequence[str], None] = 'a9dcb07dac18'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'purchase_requests',
        sa.Column('origin', sa.String(length=32), server_default='planner', nullable=False),
    )
    op.add_column('purchase_requests', sa.Column('linked_upd_number', sa.String(length=64), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('purchase_requests', 'linked_upd_number')
    op.drop_column('purchase_requests', 'origin')
