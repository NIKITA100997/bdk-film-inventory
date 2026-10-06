"""Склад готовой продукции и отгрузка по счёту

Revision ID: f7b9d1e3a5c6
Revises: e6a8c0d2f4b5
Create Date: 2026-10-06 18:00:00.000000

Право «Отгрузка готовой продукции» выдаётся ролям с users.manage, дальше —
через «Роли». Упакованное до выкладки на склад само не попадает —
оприходуется корректировкой.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f7b9d1e3a5c6'
down_revision: Union[str, Sequence[str], None] = 'e6a8c0d2f4b5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

permissions_table = sa.table("permissions", sa.column("code", sa.String), sa.column("name", sa.String), sa.column("section", sa.String))
PERMS = [("fg.ship", "Готовая продукция: отгрузка, отмена отгрузки, корректировка остатка", "Склад")]


def upgrade() -> None:
    op.create_table(
        "fg_shipments",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("invoice_no", sa.String(64), nullable=True, index=True),
        sa.Column("site_id", sa.Integer, sa.ForeignKey("sites.id"), nullable=True),
        sa.Column("customer", sa.String(255), nullable=True),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="shipped"),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("cancelled_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "fg_moves",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("item_id", sa.Integer, sa.ForeignKey("items.id"), nullable=False, index=True),
        sa.Column("qty", sa.Numeric(12, 2), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("site_id", sa.Integer, sa.ForeignKey("sites.id"), nullable=True, index=True),
        sa.Column("order_line_id", sa.Integer, sa.ForeignKey("production_order_lines.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("invoice_no", sa.String(64), nullable=True, index=True),
        sa.Column("shipment_id", sa.Integer, sa.ForeignKey("fg_shipments.id"), nullable=True, index=True),
        sa.Column("report_id", sa.Integer, sa.ForeignKey("production_task_line_reports.id", ondelete="SET NULL"), nullable=True),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False, index=True),
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
    op.drop_table("fg_moves")
    op.drop_table("fg_shipments")
