"""удаление заказов покупателей и связанных order_id

Revision ID: a9dcb07dac18
Revises: 61d24816b1b0
Create Date: 2026-08-14 10:59:09.528919

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a9dcb07dac18'
down_revision: Union[str, Sequence[str], None] = '61d24816b1b0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # order_id-колонки — сначала зависимые (material_events, material_units,
    # production_tasks), потом сами таблицы заказов. drop_column сам снимает
    # FK-констрейнт, определённый на этой же колонке — отдельный
    # drop_constraint не нужен.
    op.drop_column('material_events', 'order_id')
    op.drop_column('material_units', 'order_id')
    op.drop_column('production_tasks', 'order_id')

    # order_material_lines раньше order_material_lines.order_id -> orders.id
    op.drop_table('order_material_lines')
    op.drop_index(op.f('ix_orders_number'), table_name='orders')
    op.drop_table('orders')

    # orders.plan/orders.manage/orders.close (id 10/13/14 — см.
    # 2efa87769c18) — role_permissions.permission_id имеет
    # ondelete="CASCADE" на permissions.id, поэтому удаление строк
    # permissions само подчищает role_permissions, отдельный DELETE не нужен.
    op.execute("DELETE FROM permissions WHERE id IN (10, 13, 14)")


def downgrade() -> None:
    """Downgrade schema."""
    permissions_table = sa.table(
        "permissions",
        sa.column("id", sa.Integer()),
        sa.column("code", sa.String()),
        sa.column("name", sa.String()),
        sa.column("section", sa.String()),
    )
    op.bulk_insert(
        permissions_table,
        [
            {"id": 10, "code": "orders.plan", "name": "Строки потребности заказа", "section": "Планирование"},
            {"id": 13, "code": "orders.manage", "name": "Создание заказов", "section": "Заказы"},
            {"id": 14, "code": "orders.close", "name": "Закрытие заказа", "section": "Заказы"},
        ],
    )
    # Роли, у которых были эти права до удаления (2efa87769c18) — kladovshchik
    # (id 2) имел orders.close, nachalnik_tsekha (4) — orders.plan, logist (5)
    # — orders.manage+orders.close. Восстанавливаем то же назначение.
    role_permissions_table = sa.table(
        "role_permissions",
        sa.column("role_id", sa.Integer()),
        sa.column("permission_id", sa.Integer()),
    )
    op.bulk_insert(
        role_permissions_table,
        [
            {"role_id": 2, "permission_id": 14},
            {"role_id": 4, "permission_id": 10},
            {"role_id": 5, "permission_id": 13},
            {"role_id": 5, "permission_id": 14},
        ],
    )

    op.create_table(
        'orders',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('number', sa.String(length=64), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_orders_number'), 'orders', ['number'], unique=True)
    op.create_table(
        'order_material_lines',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('order_id', sa.Integer(), nullable=False),
        sa.Column('material_id', sa.Integer(), nullable=False),
        sa.Column('color_id', sa.Integer(), nullable=False),
        sa.Column('thickness_id', sa.Integer(), nullable=False),
        sa.Column('planned_area_m2', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.ForeignKeyConstraint(['color_id'], ['colors.id']),
        sa.ForeignKeyConstraint(['material_id'], ['materials.id']),
        sa.ForeignKeyConstraint(['order_id'], ['orders.id']),
        sa.ForeignKeyConstraint(['thickness_id'], ['thicknesses.id']),
        sa.PrimaryKeyConstraint('id'),
    )

    op.add_column('production_tasks', sa.Column('order_id', sa.Integer(), nullable=True))
    op.create_foreign_key(None, 'production_tasks', 'orders', ['order_id'], ['id'])
    op.add_column('material_units', sa.Column('order_id', sa.Integer(), nullable=True))
    op.create_foreign_key(None, 'material_units', 'orders', ['order_id'], ['id'])
    op.add_column('material_events', sa.Column('order_id', sa.Integer(), nullable=True))
    op.create_foreign_key(None, 'material_events', 'orders', ['order_id'], ['id'], ondelete='SET NULL')
