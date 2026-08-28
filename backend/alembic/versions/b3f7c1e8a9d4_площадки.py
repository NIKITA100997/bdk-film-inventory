"""Площадки

Revision ID: b3f7c1e8a9d4
Revises: a1c7d4e9f6b2
Create Date: 2026-08-28 17:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b3f7c1e8a9d4'
down_revision: Union[str, Sequence[str], None] = 'a1c7d4e9f6b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SEVERNY_AREAS = [
    'okutka_tsargovykh',
    'tselnolistovye_dveri',
    'uchastok_laminatsii_naruzhnikh_tselnolistovykh_paneley_metallicheskikh_dverey',
    'uchastok_laminatsii_obemnykh_filenok',
    'uchastok_membranno_vakuumnykh_pressov',
]
FABRIKA_AREAS = ['fabrika']


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'sites',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('warehouse_id', sa.Integer(), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['warehouse_id'], ['warehouses.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'),
    )
    op.add_column('areas', sa.Column('site_id', sa.Integer(), nullable=True))
    op.create_foreign_key(None, 'areas', 'sites', ['site_id'], ['id'])

    # Реальные площадки компании (раздел про площадки, 2026-08-28) — Северный
    # (основная, склад "Основной склад") и Фабрика (свой склад "Фабрика").
    op.execute(
        "INSERT INTO sites (name, warehouse_id, is_active) "
        "SELECT 'Северный', id, true FROM warehouses WHERE name = 'Основной склад'"
    )
    op.execute(
        "INSERT INTO sites (name, warehouse_id, is_active) "
        "SELECT 'Фабрика', id, true FROM warehouses WHERE name = 'Фабрика'"
    )
    severny_codes = "', '".join(SEVERNY_AREAS)
    op.execute(
        f"UPDATE areas SET site_id = (SELECT id FROM sites WHERE name = 'Северный') "
        f"WHERE code IN ('{severny_codes}')"
    )
    fabrika_codes = "', '".join(FABRIKA_AREAS)
    op.execute(
        f"UPDATE areas SET site_id = (SELECT id FROM sites WHERE name = 'Фабрика') "
        f"WHERE code IN ('{fabrika_codes}')"
    )
    # shchitovye_dveri сознательно не трогаем — участок неактивен, щитовые
    # панели производят линии других участков, своей площадки не назначаем.


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(None, 'areas', type_='foreignkey')
    op.drop_column('areas', 'site_id')
    op.drop_table('sites')
