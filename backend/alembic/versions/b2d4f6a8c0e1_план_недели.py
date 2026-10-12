"""План недели с утверждением (12.10, планирование, этап 3)

Revision ID: b2d4f6a8c0e1
Revises: a1c3e5f7b9d2
Create Date: 2026-10-12 20:00:00.000000

production_plans — неделя (понедельник): черновик → на утверждении →
утверждён; изменение после утверждения — «изменён», версия растёт при
каждом утверждении. production_plan_items — снимок состава при
отправке/утверждении (заказ, даты, приоритет); production_plan_events —
журнал: отправлен, утверждён, возвращён, срочный заказ, перенос. Право
plan.approve — утверждать план (ролям не выдаётся).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b2d4f6a8c0e1'
down_revision: Union[str, Sequence[str], None] = 'a1c3e5f7b9d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

permissions_table = sa.table("permissions", sa.column("code", sa.String), sa.column("name", sa.String), sa.column("section", sa.String))


def upgrade() -> None:
    op.create_table(
        "production_plans",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("week_start", sa.Date, nullable=False, unique=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
        sa.Column("version", sa.Integer, nullable=False, server_default="0"),
        sa.Column("submitted_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("comment", sa.String(500), nullable=True),
    )
    op.create_table(
        "production_plan_items",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("plan_id", sa.Integer, sa.ForeignKey("production_plans.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("order_id", sa.Integer, sa.ForeignKey("production_orders.id", ondelete="SET NULL"), nullable=True),
        sa.Column("order_name", sa.String(255), nullable=False),
        sa.Column("priority", sa.SmallInteger, nullable=False, server_default="0"),
        sa.Column("promised_ready", sa.Date, nullable=True),
        sa.Column("ship_date", sa.Date, nullable=True),
        sa.Column("qty", sa.Numeric(12, 2), nullable=False, server_default="0"),
    )
    op.create_table(
        "production_plan_events",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("plan_id", sa.Integer, sa.ForeignKey("production_plans.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("text", sa.String(500), nullable=False),
        sa.Column("order_id", sa.Integer, nullable=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.bulk_insert(permissions_table, [{"code": "plan.approve", "name": "План недели: утверждать и возвращать", "section": "Планирование"}])


def downgrade() -> None:
    op.execute("DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE code = 'plan.approve')")
    op.execute("DELETE FROM permissions WHERE code = 'plan.approve'")
    op.drop_table("production_plan_events")
    op.drop_table("production_plan_items")
    op.drop_table("production_plans")
