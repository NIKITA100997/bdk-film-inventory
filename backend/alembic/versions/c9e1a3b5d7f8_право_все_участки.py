"""право «Задания всех участков» (14.10)

Пользователь с участком в профиле видит и ведёт задания только своего
участка, если у него нет этого права (раньше ограничение снимало право
«управление заданиями цеха», и начальники участков видели все участки).
Выдаётся ролям, которые по сути работают со всеми участками: начальник
склада и участка плёнки («Оператор склада»), начальник цеха, логист.

Revision ID: c9e1a3b5d7f8
Revises: b8d0f2a4c6e7
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c9e1a3b5d7f8"
down_revision: Union[str, Sequence[str], None] = "b8d0f2a4c6e7"
branch_labels = None
depends_on = None

CODE = "production_tasks.all_areas"
ROLES = ("Оператор склада", "Начальник цеха", "Логист/руководитель")


def upgrade() -> None:
    op.execute(sa.text(
        "INSERT INTO permissions (code, name, section) VALUES (:c, :n, 'Производство') ON CONFLICT (code) DO NOTHING"
    ).bindparams(c=CODE, n="Задания всех участков: видеть и вести задания не только своего участка"))
    op.execute(sa.text(
        "INSERT INTO role_permissions (role_id, permission_id) "
        "SELECT r.id, p.id FROM roles r, permissions p WHERE p.code = :c AND r.name = ANY(:roles) "
        "AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)"
    ).bindparams(c=CODE, roles=list(ROLES)))


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE code = :c)").bindparams(c=CODE))
    op.execute(sa.text("DELETE FROM permissions WHERE code = :c").bindparams(c=CODE))
