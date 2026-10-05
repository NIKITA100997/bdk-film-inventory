"""Цены позиций и валюты с общим курсом; права на цены

Revision ID: f6c8e0a2b4d5
Revises: e5b7d9f1a3c4
Create Date: 2026-10-05 12:00:00.000000

Курсы евро и доллара не заполняются — их задают в «Настройках»; до этого
цены в этих валютах в рубли не пересчитываются. Права «Цены: просмотр» и
«Цены: ведение» выдаются ролям с users.manage, дальше — через «Роли».
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f6c8e0a2b4d5'
down_revision: Union[str, Sequence[str], None] = 'e5b7d9f1a3c4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

permissions_table = sa.table("permissions", sa.column("code", sa.String), sa.column("name", sa.String), sa.column("section", sa.String))
currencies_table = sa.table(
    "currencies", sa.column("code", sa.String), sa.column("name", sa.String), sa.column("symbol", sa.String),
    sa.column("rate", sa.Numeric),
)
PERMS = [
    ("prices.view", "Цены и себестоимость: просмотр", "Цены"),
    ("prices.manage", "Цены и курсы валют: ведение, загрузка из 1С", "Цены"),
]


def upgrade() -> None:
    op.create_table(
        "currencies",
        sa.Column("code", sa.String(3), primary_key=True),
        sa.Column("name", sa.String(32), nullable=False),
        sa.Column("symbol", sa.String(4), nullable=False),
        sa.Column("rate", sa.Numeric(14, 4), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
    )
    op.bulk_insert(currencies_table, [
        {"code": "RUB", "name": "Рубль", "symbol": "₽", "rate": 1},
        {"code": "EUR", "name": "Евро", "symbol": "€", "rate": None},
        {"code": "USD", "name": "Доллар США", "symbol": "$", "rate": None},
    ])
    op.create_table(
        "item_prices",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("item_id", sa.Integer, sa.ForeignKey("items.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("price", sa.Numeric(14, 4), nullable=False),
        sa.Column("currency", sa.String(3), sa.ForeignKey("currencies.code"), nullable=False),
        sa.Column("unit", sa.String(16), nullable=False),
        sa.Column("source", sa.String(8), nullable=False),
        sa.Column("doc", sa.String(64), nullable=True),
        sa.Column("valid_from", sa.Date, nullable=False, index=True),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.add_column("items", sa.Column("price_currency", sa.String(3), nullable=True))
    op.add_column("items", sa.Column("price_unit", sa.String(16), nullable=True))
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
    op.drop_column("items", "price_unit")
    op.drop_column("items", "price_currency")
    op.drop_table("item_prices")
    op.drop_table("currencies")
