"""Заказы поставщикам

Revision ID: 6a3e7fb52bdd
Revises: 2b8ff1b0c7df
Create Date: 2026-08-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6a3e7fb52bdd'
down_revision: Union[str, Sequence[str], None] = '2b8ff1b0c7df'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'supplier_orders',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('supplier_id', sa.Integer(), nullable=False),
        sa.Column('note', sa.String(length=255), nullable=True),
        sa.Column('created_by', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], name='supplier_orders_supplier_id_fkey'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], name='supplier_orders_created_by_fkey'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.add_column('purchase_requests', sa.Column('order_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'purchase_requests_order_id_fkey', 'purchase_requests', 'supplier_orders', ['order_id'], ['id']
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('purchase_requests_order_id_fkey', 'purchase_requests', type_='foreignkey')
    op.drop_column('purchase_requests', 'order_id')
    op.drop_table('supplier_orders')
