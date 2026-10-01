"""Отдельное право на обход запрета лишнего перемещения на площадку

Revision ID: a7d2e4f6b813
Revises: c3a7e9b1d5f4
Create Date: 2026-10-01 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7d2e4f6b813'
down_revision: Union[str, Sequence[str], None] = 'c3a7e9b1d5f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


permissions_table = sa.table(
    "permissions",
    sa.column("code", sa.String),
    sa.column("name", sa.String),
    sa.column("section", sa.String),
)

# Раньше обход запрета (home_stock_guard) давал users.manage — вместе с
# управлением пользователями. Теперь отдельное право; чтобы ничего не
# поменялось в день выкладки, выдаём его тем же ролям, у кого есть
# users.manage. Дальше — вручную через «Роли».
CODE = "units.transfer_override"


def upgrade() -> None:
    op.bulk_insert(permissions_table, [
        {"code": CODE, "name": "Перемещение на площадку, где плёнки уже хватает (с причиной)", "section": "Склад"},
    ])
    op.execute(f"""
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT rp.role_id, (SELECT id FROM permissions WHERE code = '{CODE}')
        FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
        WHERE p.code = 'users.manage'
    """)


def downgrade() -> None:
    op.execute(f"DELETE FROM permissions WHERE code = '{CODE}'")
