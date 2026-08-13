"""bom_bez_tsveta_materiala_uchastok_na_detal

Revision ID: 05ec7abf6a39
Revises: 310bacaa0e01
Create Date: 2026-08-13 09:45:04.839748

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '05ec7abf6a39'
down_revision: Union[str, Sequence[str], None] = '310bacaa0e01'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

AREA_ENUM = postgresql.ENUM(
    'OKUTKA_TSARGOVYKH', 'SHCHITOVYE_DVERI', 'TSELNOLISTOVYE_DVERI', name='area', create_type=False
)


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('product_model_parts', sa.Column('area', AREA_ENUM, nullable=True))
    op.execute(
        """
        UPDATE product_model_parts
        SET area = product_models.area
        FROM product_models
        WHERE product_model_parts.product_model_id = product_models.id
        """
    )
    op.alter_column('product_model_parts', 'area', nullable=False)

    op.drop_constraint(op.f('product_model_parts_thickness_id_fkey'), 'product_model_parts', type_='foreignkey')
    op.drop_constraint(op.f('product_model_parts_line_id_fkey'), 'product_model_parts', type_='foreignkey')
    op.drop_constraint(op.f('product_model_parts_color_id_fkey'), 'product_model_parts', type_='foreignkey')
    op.drop_constraint(op.f('product_model_parts_material_id_fkey'), 'product_model_parts', type_='foreignkey')
    op.drop_column('product_model_parts', 'material_id')
    op.drop_column('product_model_parts', 'color_id')
    op.drop_column('product_model_parts', 'line_id')
    op.drop_column('product_model_parts', 'thickness_id')


def downgrade() -> None:
    """Downgrade schema."""
    op.add_column('product_model_parts', sa.Column('thickness_id', sa.INTEGER(), autoincrement=False, nullable=True))
    op.add_column('product_model_parts', sa.Column('line_id', sa.INTEGER(), autoincrement=False, nullable=True))
    op.add_column('product_model_parts', sa.Column('color_id', sa.INTEGER(), autoincrement=False, nullable=True))
    op.add_column('product_model_parts', sa.Column('material_id', sa.INTEGER(), autoincrement=False, nullable=True))
    op.create_foreign_key(op.f('product_model_parts_material_id_fkey'), 'product_model_parts', 'materials', ['material_id'], ['id'])
    op.create_foreign_key(op.f('product_model_parts_color_id_fkey'), 'product_model_parts', 'colors', ['color_id'], ['id'])
    op.create_foreign_key(op.f('product_model_parts_line_id_fkey'), 'product_model_parts', 'production_lines', ['line_id'], ['id'])
    op.create_foreign_key(op.f('product_model_parts_thickness_id_fkey'), 'product_model_parts', 'thicknesses', ['thickness_id'], ['id'])
    op.drop_column('product_model_parts', 'area')
