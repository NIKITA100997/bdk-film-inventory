"""Заявки на удаление

Revision ID: 9c1f2e6a4d3b
Revises: 6a3e7fb52bdd
Create Date: 2026-08-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9c1f2e6a4d3b'
down_revision: Union[str, Sequence[str], None] = '6a3e7fb52bdd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'deletion_requests',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('entity_type', sa.String(length=32), nullable=False),
        sa.Column('entity_id', sa.Integer(), nullable=False),
        sa.Column('entity_label', sa.String(length=255), nullable=False),
        sa.Column('reason', sa.String(length=255), nullable=True),
        sa.Column('status', sa.String(length=16), server_default='pending', nullable=False),
        sa.Column('requested_by', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('resolved_by', sa.Integer(), nullable=True),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('resolution_note', sa.String(length=255), nullable=True),
        sa.ForeignKeyConstraint(['requested_by'], ['users.id'], name='deletion_requests_requested_by_fkey'),
        sa.ForeignKeyConstraint(['resolved_by'], ['users.id'], name='deletion_requests_resolved_by_fkey'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.add_column('production_tasks', sa.Column('is_active', sa.Boolean(), server_default=sa.true(), nullable=False))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('production_tasks', 'is_active')
    op.drop_table('deletion_requests')
