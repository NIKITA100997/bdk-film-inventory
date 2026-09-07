"""Адресное хранение п/ф — стеллажи

Revision ID: 6b91a6666b5e
Revises: 119fbe243271
Create Date: 2026-09-07 11:27:30.831022

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6b91a6666b5e'
down_revision: Union[str, Sequence[str], None] = '119fbe243271'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


permissions_table = sa.table(
    "permissions",
    sa.column("code", sa.String),
    sa.column("name", sa.String),
    sa.column("section", sa.String),
)
role_permissions_table = sa.table(
    "role_permissions",
    sa.column("role_id", sa.Integer),
    sa.column("permission_id", sa.Integer),
)

# role_id 4/5 = nachalnik_tsekha/logist (см. 2efa87769c18_гибкая_ролевая_
# модель_ролей_и_прав.py) — та же пара, что уже держит storage.manage у
# стеллажей плёнки.
NEW_PERMISSIONS = [
    {"code": "part_storage.manage", "name": "Стеллажи п/ф", "section": "Производство"},
]


def upgrade() -> None:
    op.create_table(
        "part_racks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("code", sa.String(length=128), nullable=False),
        sa.Column("shelf_count", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
    )
    op.create_index(op.f("ix_part_racks_code"), "part_racks", ["code"])

    op.add_column("part_unit_events", sa.Column("from_cell", sa.String(length=64), nullable=True))
    op.add_column("part_unit_events", sa.Column("to_cell", sa.String(length=64), nullable=True))

    # Новое значение существующего enum (раздел про событие "Размещение") —
    # ADD VALUE не может выполниться в одной транзакции с использованием
    # этого значения, но здесь оно только добавляется, не используется.
    op.execute("ALTER TYPE part_event_type ADD VALUE IF NOT EXISTS 'RAZMESHCHENIE'")

    op.bulk_insert(permissions_table, NEW_PERMISSIONS)
    conn = op.get_bind()
    manage_id = conn.execute(
        sa.text("SELECT id FROM permissions WHERE code = 'part_storage.manage'")
    ).scalar_one()
    op.bulk_insert(
        role_permissions_table,
        [{"role_id": role_id, "permission_id": manage_id} for role_id in (4, 5)],
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM role_permissions WHERE permission_id IN "
        "(SELECT id FROM permissions WHERE code = 'part_storage.manage')"
    )
    op.execute("DELETE FROM permissions WHERE code = 'part_storage.manage'")

    op.drop_column("part_unit_events", "to_cell")
    op.drop_column("part_unit_events", "from_cell")

    op.drop_index(op.f("ix_part_racks_code"), table_name="part_racks")
    op.drop_table("part_racks")

    # Postgres не умеет удалять одно значение enum — откат enum-а не
    # предусмотрен (тот же осознанный компромисс, что и у остальных
    # ADD VALUE-миграций в этом проекте).
