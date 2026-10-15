"""резерв плёнки под заказ (15.10)

Revision ID: e3a5c7d9f1b4
Revises: d1f3b5c7e9a2
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e3a5c7d9f1b4"
down_revision: Union[str, Sequence[str], None] = "d1f3b5c7e9a2"
branch_labels = None
depends_on = None

CODE = "film_reserve.override"


def upgrade() -> None:
    op.create_table(
        "film_reservations",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("unit_id", sa.Integer, sa.ForeignKey("material_units.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("length_m", sa.Numeric(12, 3), nullable=False),
        sa.Column("area_m2", sa.Numeric(12, 3), nullable=False),
        sa.Column("task_line_id", sa.Integer, sa.ForeignKey("production_task_lines.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("customer_order_id", sa.Integer, sa.ForeignKey("customer_orders.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("strip_width_mm", sa.Numeric(10, 2), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="active", index=True),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("closed_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(sa.text(
        "INSERT INTO permissions (code, name, section) VALUES (:c, :n, 'Склад') ON CONFLICT (code) DO NOTHING"
    ).bindparams(c=CODE, n="Перехват резерва плёнки: снять чужой резерв, выдать или разрезать зарезервированное под другой заказ"))
    op.execute(sa.text(
        "INSERT INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p "
        "WHERE p.code = :c AND r.name = 'Начальник цеха' "
        "AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)"
    ).bindparams(c=CODE))


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE code = :c)").bindparams(c=CODE))
    op.execute(sa.text("DELETE FROM permissions WHERE code = :c").bindparams(c=CODE))
    op.drop_table("film_reservations")
