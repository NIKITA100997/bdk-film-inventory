"""перемещения между складами

Revision ID: c8a2f4e1b6d3
Revises: b3f7c1e8a9d4
Create Date: 2026-08-31 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c8a2f4e1b6d3'
down_revision: Union[str, Sequence[str], None] = 'b3f7c1e8a9d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'warehouse_transfers',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('from_warehouse_id', sa.Integer(), nullable=False),
        sa.Column('to_warehouse_id', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False, server_default='sobiraetsya'),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('created_by', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('shipped_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('received_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.ForeignKeyConstraint(['from_warehouse_id'], ['warehouses.id']),
        sa.ForeignKeyConstraint(['to_warehouse_id'], ['warehouses.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_table(
        'warehouse_transfer_lines',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('transfer_id', sa.Integer(), nullable=False),
        sa.Column('unit_id', sa.Integer(), nullable=False),
        sa.Column('added_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('received_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['transfer_id'], ['warehouse_transfers.id']),
        sa.ForeignKeyConstraint(['unit_id'], ['material_units.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_warehouse_transfer_lines_transfer_id', 'warehouse_transfer_lines', ['transfer_id'])
    op.create_index('ix_warehouse_transfer_lines_unit_id', 'warehouse_transfer_lines', ['unit_id'])
    # Единица не может одновременно быть в двух ещё не принятых
    # перемещениях (раздел про хаб) — частичный уникальный индекс вместо
    # прикладной проверки, защищает и от гонки параллельных запросов.
    op.create_index(
        'ix_warehouse_transfer_lines_active_unit',
        'warehouse_transfer_lines',
        ['unit_id'],
        unique=True,
        postgresql_where=sa.text('received_at IS NULL'),
    )

    # Alembic autogenerate не видит новые значения существующего Postgres
    # ENUM — значение это .name Python-enum, не кириллический .value (тот
    # же приём, что уже использовался для DONOR_PREDLOZHEN/предыдущих
    # добавлений значений enum в этом проекте).
    op.execute("ALTER TYPE unit_status ADD VALUE IF NOT EXISTS 'V_PEREMESHCHENII'")
    op.execute("ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'PEREMESHCHENIE_NACHATO'")
    op.execute("ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'PEREMESHCHENIE_PRINYATO'")

    # Новое право — раздел про хаб на перемещение между складами. Сразу
    # выдаём его operator_sklada (id=1, уже держит весь остальной набор
    # units.*) — остальным ролям админ выдаст руками через "Пользователи".
    op.execute(
        "INSERT INTO permissions (code, name, section) "
        "VALUES ('warehouse_transfers.manage', 'Перемещение между складами', 'Склад')"
    )
    op.execute(
        "INSERT INTO role_permissions (role_id, permission_id) "
        "SELECT 1, id FROM permissions WHERE code = 'warehouse_transfers.manage'"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DELETE FROM permissions WHERE code = 'warehouse_transfers.manage'")
    op.drop_index('ix_warehouse_transfer_lines_active_unit', table_name='warehouse_transfer_lines')
    op.drop_index('ix_warehouse_transfer_lines_unit_id', table_name='warehouse_transfer_lines')
    op.drop_index('ix_warehouse_transfer_lines_transfer_id', table_name='warehouse_transfer_lines')
    op.drop_table('warehouse_transfer_lines')
    op.drop_table('warehouse_transfers')
    # Postgres не поддерживает удаление одного значения ENUM — новые
    # значения unit_status/event_type остаются в типе (безвредно, просто
    # больше никогда не используются после отката таблиц).
