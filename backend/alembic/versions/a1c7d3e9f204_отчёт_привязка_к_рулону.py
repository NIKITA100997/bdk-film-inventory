"""Отчёт о производстве — привязка к рулону (№ штрипса)

Revision ID: a1c7d3e9f204
Revises: fc3a35f5e4dd
Create Date: 2026-09-03 11:10:09.776243

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1c7d3e9f204'
down_revision: Union[str, Sequence[str], None] = 'fc3a35f5e4dd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'production_task_line_reports',
        sa.Column('material_unit_id', sa.Integer(), nullable=True),
    )
    op.create_index(
        op.f('ix_production_task_line_reports_material_unit_id'),
        'production_task_line_reports', ['material_unit_id'],
    )
    op.create_foreign_key(
        None, 'production_task_line_reports', 'material_units', ['material_unit_id'], ['id'],
        ondelete='SET NULL',
    )


def downgrade() -> None:
    op.drop_constraint(None, 'production_task_line_reports', type_='foreignkey')
    op.drop_index(
        op.f('ix_production_task_line_reports_material_unit_id'),
        table_name='production_task_line_reports',
    )
    op.drop_column('production_task_line_reports', 'material_unit_id')
