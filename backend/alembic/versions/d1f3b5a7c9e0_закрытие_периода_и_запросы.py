"""Закрытие периода и запросы администратору

Revision ID: d1f3b5a7c9e0
Revises: c0e2a4b6d8f9
Create Date: 2026-10-07 12:00:00.000000

Права «Закрытие периода» и «Подтверждение запросов сотрудников» выдаются
ролям с users.manage, дальше — через «Роли».
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd1f3b5a7c9e0'
down_revision: Union[str, Sequence[str], None] = 'c0e2a4b6d8f9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

permissions_table = sa.table("permissions", sa.column("code", sa.String), sa.column("name", sa.String), sa.column("section", sa.String))
PERMS = [
    ("period.manage", "Закрытие и открытие периода", "Администрирование"),
    ("requests.approve", "Подтверждение запросов сотрудников (выполнить запрещённое действие)", "Администрирование"),
]


def upgrade() -> None:
    op.create_table(
        "period_closings",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("closed_until", sa.Date, nullable=True),
        sa.Column("action", sa.String(8), nullable=False),
        sa.Column("reason", sa.String(255), nullable=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "action_requests",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("method", sa.String(8), nullable=False),
        sa.Column("path", sa.String(500), nullable=False),
        sa.Column("body", sa.Text, nullable=True),
        sa.Column("summary", sa.String(500), nullable=False),
        sa.Column("error", sa.String(500), nullable=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("page", sa.String(255), nullable=True),
        sa.Column("comment", sa.String(500), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending", index=True),
        sa.Column("requested_by", sa.Integer, sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("resolved_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result", sa.String(500), nullable=True),
        sa.Column("seen", sa.Boolean, nullable=False, server_default="false"),
    )
    op.bulk_insert(permissions_table, [{"code": c, "name": n, "section": s} for c, n, s in PERMS])
    for code, _, _ in PERMS:
        op.execute(f"""
            INSERT INTO role_permissions (role_id, permission_id)
            SELECT rp.role_id, (SELECT id FROM permissions WHERE code = '{code}')
            FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
            WHERE p.code = 'users.manage'
        """)


def downgrade() -> None:
    for code, _, _ in PERMS:
        op.execute(f"DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE code = '{code}')")
        op.execute(f"DELETE FROM permissions WHERE code = '{code}'")
    op.drop_table("action_requests")
    op.drop_table("period_closings")
