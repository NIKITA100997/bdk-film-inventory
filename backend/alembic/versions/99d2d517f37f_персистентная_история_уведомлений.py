"""персистентная история уведомлений

Заводит `notifications` — заменяет чистый живой пересчёт сигнала в
колокольчике на реальную историю появления (first_seen_at), разрешения
(resolved_at) и прочитано (read_at/read_by). read/unread — глобальный на
уведомление, не per-user (см. models/notifications.py).

Revision ID: 99d2d517f37f
Revises: ee2927685854
Create Date: 2026-08-21 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '99d2d517f37f'
down_revision: Union[str, Sequence[str], None] = 'ee2927685854'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("signal_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("detail", sa.String(length=500), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("read_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["read_by"], ["users.id"], name="notifications_read_by_fkey"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_notifications_signal_entity", "notifications", ["signal_type", "entity_id"])


def downgrade() -> None:
    op.drop_index("ix_notifications_signal_entity", table_name="notifications")
    op.drop_table("notifications")
