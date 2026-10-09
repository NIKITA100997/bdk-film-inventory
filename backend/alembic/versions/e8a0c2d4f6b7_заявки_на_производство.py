"""Заявки менеджеров на производство: вилка отгрузки и статус заявки

Revision ID: e8a0c2d4f6b7
Revises: d7f9b1c3e5a6
Create Date: 2026-10-09 19:00:00.000000

Продажник заводит заказ-черновик с вилкой отгрузки (ship_from–ship_to) и
отправляет в производство; начальник цеха принимает — ставит твёрдую дату
отгрузки (ship_date, 100%) — или возвращает с комментарием. Право
orders.request ролям не выдаётся: ставится в «Ролях».
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e8a0c2d4f6b7'
down_revision: Union[str, Sequence[str], None] = 'd7f9b1c3e5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

permissions_table = sa.table("permissions", sa.column("code", sa.String), sa.column("name", sa.String), sa.column("section", sa.String))


def upgrade() -> None:
    op.add_column("production_orders", sa.Column("ship_from", sa.Date, nullable=True))
    op.add_column("production_orders", sa.Column("ship_to", sa.Date, nullable=True))
    op.add_column("production_orders", sa.Column("request_status", sa.String(16), nullable=True))
    op.add_column("production_orders", sa.Column("request_comment", sa.String(500), nullable=True))
    op.add_column("production_orders", sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("production_orders", sa.Column("submitted_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True))
    op.add_column("production_orders", sa.Column("decided_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True))
    op.add_column("production_orders", sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True))
    op.bulk_insert(permissions_table, [{
        "code": "orders.request",
        "name": "Заявки на производство: заводить, видеть все заказы, отправлять в производство",
        "section": "Производство",
    }])


def downgrade() -> None:
    op.execute("DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE code = 'orders.request')")
    op.execute("DELETE FROM permissions WHERE code = 'orders.request'")
    for c in ("decided_at", "decided_by", "submitted_by", "submitted_at", "request_comment", "request_status", "ship_to", "ship_from"):
        op.drop_column("production_orders", c)
