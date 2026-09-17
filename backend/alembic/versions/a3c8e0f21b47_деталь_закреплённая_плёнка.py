"""Деталь — закреплённая плёнка (default_material_sku_id)

Revision ID: a3c8e0f21b47
Revises: f1a9c3d7e825
Create Date: 2026-09-17 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a3c8e0f21b47'
down_revision: Union[str, Sequence[str], None] = 'f1a9c3d7e825'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('parts', sa.Column('default_material_sku_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'parts_default_material_sku_id_fkey', 'parts', 'material_skus', ['default_material_sku_id'], ['id']
    )


def downgrade() -> None:
    op.drop_constraint('parts_default_material_sku_id_fkey', 'parts', type_='foreignkey')
    op.drop_column('parts', 'default_material_sku_id')
