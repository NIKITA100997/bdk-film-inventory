"""журнал резок и отмена

Revision ID: d4e8f2a6c9b1
Revises: a3f9d2e6b4c1
Create Date: 2026-09-01 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd4e8f2a6c9b1'
down_revision: Union[str, Sequence[str], None] = 'a3f9d2e6b4c1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'cutting_operations',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('donor_unit_id', sa.Integer(), nullable=False),
        sa.Column('donor_material_sku_id', sa.Integer(), nullable=False),
        sa.Column('donor_width_before_mm', sa.Numeric(10, 2), nullable=False),
        sa.Column('donor_length_before_m', sa.Numeric(12, 3), nullable=False),
        sa.Column('donor_status_before', sa.String(length=32), nullable=False),
        sa.Column('donor_location_code_before', sa.String(length=32), nullable=True),
        sa.Column('donor_width_after_mm', sa.Numeric(10, 2), nullable=False),
        sa.Column('donor_length_after_m', sa.Numeric(12, 3), nullable=False),
        sa.Column('donor_status_after', sa.String(length=32), nullable=False),
        sa.Column('donor_auto_written_off', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('length_precut_m', sa.Numeric(12, 3), nullable=True),
        sa.Column('required_permissions', sa.String(length=255), nullable=False, server_default=''),
        sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('undone_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('undone_by', sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(['donor_unit_id'], ['material_units.id']),
        sa.ForeignKeyConstraint(['donor_material_sku_id'], ['material_skus.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['undone_by'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_cutting_operations_donor_unit_id', 'cutting_operations', ['donor_unit_id'])
    op.create_index('ix_cutting_operations_donor_material_sku_id', 'cutting_operations', ['donor_material_sku_id'])

    op.add_column(
        'material_events',
        sa.Column('cutting_operation_id', sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        'fk_material_events_cutting_operation_id',
        'material_events', 'cutting_operations',
        ['cutting_operation_id'], ['id'], ondelete='SET NULL',
    )
    op.create_index('ix_material_events_cutting_operation_id', 'material_events', ['cutting_operation_id'])

    op.add_column(
        'material_units',
        sa.Column('created_by_cutting_operation_id', sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        'fk_material_units_created_by_cutting_operation_id',
        'material_units', 'cutting_operations',
        ['created_by_cutting_operation_id'], ['id'], ondelete='SET NULL',
    )
    op.create_index(
        'ix_material_units_created_by_cutting_operation_id', 'material_units', ['created_by_cutting_operation_id']
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_material_units_created_by_cutting_operation_id', table_name='material_units')
    op.drop_constraint('fk_material_units_created_by_cutting_operation_id', 'material_units', type_='foreignkey')
    op.drop_column('material_units', 'created_by_cutting_operation_id')

    op.drop_index('ix_material_events_cutting_operation_id', table_name='material_events')
    op.drop_constraint('fk_material_events_cutting_operation_id', 'material_events', type_='foreignkey')
    op.drop_column('material_events', 'cutting_operation_id')

    op.drop_index('ix_cutting_operations_donor_material_sku_id', table_name='cutting_operations')
    op.drop_index('ix_cutting_operations_donor_unit_id', table_name='cutting_operations')
    op.drop_table('cutting_operations')
