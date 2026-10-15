"""право «Счета отгрузки ГП» и участок «Выдача плёнки» (15.10)

Revision ID: a8c0e2f4b6d9
Revises: f5b7d9e1a3c6

Счета отгрузки были открыты всем — решение 15.10: оставить всем, но
отдельным правом (выдаётся всем ролям, снимается в «Ролях»). Участок
«Выдача плёнки» на Северном — здесь режут и выдают плёнку; его задания —
доска выдачи.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a8c0e2f4b6d9"
down_revision: Union[str, Sequence[str], None] = "f5b7d9e1a3c6"
branch_labels = None
depends_on = None

CODE = "fg.invoices"
AREA = "vydacha_plenki"


def upgrade() -> None:
    op.execute(sa.text(
        "INSERT INTO permissions (code, name, section) VALUES (:c, :n, 'Склад') ON CONFLICT (code) DO NOTHING"
    ).bindparams(c=CODE, n="Счета отгрузки готовой продукции: просмотр (заказано, упаковано, отгружено)"))
    op.execute(sa.text(
        "INSERT INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p "
        "WHERE p.code = :c AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)"
    ).bindparams(c=CODE))
    op.execute(sa.text(
        "INSERT INTO areas (code, name, is_active, site_id, requires_daily_plan, film_issue_point) "
        "SELECT :code, 'Выдача плёнки', true, (SELECT id FROM sites WHERE name = 'Северный'), false, true "
        "WHERE NOT EXISTS (SELECT 1 FROM areas WHERE code = :code OR name = 'Выдача плёнки')"
    ).bindparams(code=AREA))


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM areas WHERE code = :code AND NOT EXISTS (SELECT 1 FROM users WHERE area = :code)").bindparams(code=AREA))
    op.execute(sa.text("DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE code = :c)").bindparams(c=CODE))
    op.execute(sa.text("DELETE FROM permissions WHERE code = :c").bindparams(c=CODE))
