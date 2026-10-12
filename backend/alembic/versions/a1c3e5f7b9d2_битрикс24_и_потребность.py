"""Битрикс24 и потребность: настройки, пользователи, журнал сообщений, «нужно к» у заявки на закупку

Revision ID: a1c3e5f7b9d2
Revises: f9b1d3e5a7c8
Create Date: 2026-10-12 16:00:00.000000

Битрикс24 (облако, входящий вебхук): адрес вебхука и чаты — в app_settings
(не в git); сотрудник программы ↔ пользователь Битрикса — users.bitrix_user_id;
каждое сообщение — в bitrix_outbox (отправлено / ошибка, можно повторить).
Потребность, этап 2: заявка на закупку плёнки помнит, к какому дню нужна
и под какие заказы.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1c3e5f7b9d2'
down_revision: Union[str, Sequence[str], None] = 'f9b1d3e5a7c8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("value", sa.JSON, nullable=True),
        sa.Column("updated_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.add_column("users", sa.Column("bitrix_user_id", sa.Integer, nullable=True))
    op.create_table(
        "bitrix_outbox",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("event", sa.String(32), nullable=False),
        sa.Column("method", sa.String(64), nullable=False),
        sa.Column("params", sa.JSON, nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="new"),  # new / sent / error / skipped
        sa.Column("error", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False, index=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column("purchase_requests", sa.Column("need_by", sa.Date, nullable=True))


def downgrade() -> None:
    op.drop_column("purchase_requests", "need_by")
    op.drop_table("bitrix_outbox")
    op.drop_column("users", "bitrix_user_id")
    op.drop_table("app_settings")
