"""Заказ: клиент, сумма, приоритет, обещанная готовность, история дат; производственный календарь

Revision ID: f9b1d3e5a7c8
Revises: e8a0c2d4f6b7
Create Date: 2026-10-12 12:00:00.000000

Планирование заказов, этап 1 (12.10): менеджер ставит приоритет, клиент и
сумма — из счёта; производство обещает две даты — готовность
(promised_ready) и отгрузку (ship_date); каждый перенос после приёма — в
order_date_changes с причиной. Производственный календарь: пятидневка с
праздниками РФ; день можно сделать рабочим или нерабочим для всех или для
одного участка (суббота, отключили свет).
"""
from datetime import date
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f9b1d3e5a7c8'
down_revision: Union[str, Sequence[str], None] = 'e8a0c2d4f6b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Нерабочие праздничные будни (Трудовой кодекс, ст. 112). Переносы выходных
# по постановлению правительства — правятся в календаре вручную.
HOLIDAYS = [
    (date(2026, 11, 4), "День народного единства"),
    (date(2026, 12, 31), "Перенос выходного (31 декабря)"),
    *[(date(2027, 1, d), "Новогодние каникулы") for d in range(1, 9)],
    (date(2027, 2, 23), "День защитника Отечества"),
    (date(2027, 3, 8), "Международный женский день"),
    (date(2027, 6, 14), "День России (перенос с 12.06)"),
    (date(2027, 11, 4), "День народного единства"),
]


def upgrade() -> None:
    op.add_column("production_orders", sa.Column("customer", sa.String(255), nullable=True))
    op.add_column("production_orders", sa.Column("amount_rub", sa.Numeric(14, 2), nullable=True))
    op.add_column("production_orders", sa.Column("priority", sa.SmallInteger, nullable=False, server_default="0"))
    op.add_column("production_orders", sa.Column("promised_ready", sa.Date, nullable=True))
    op.add_column("production_orders", sa.Column("ready_at", sa.Date, nullable=True))
    op.create_table(
        "order_date_changes",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("order_id", sa.Integer, sa.ForeignKey("production_orders.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("field", sa.String(16), nullable=False),  # ship / ready
        sa.Column("old_date", sa.Date, nullable=True),
        sa.Column("new_date", sa.Date, nullable=True),
        sa.Column("reason", sa.String(32), nullable=True),
        sa.Column("comment", sa.String(500), nullable=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    cal = op.create_table(
        "production_calendar",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("day", sa.Date, nullable=False, index=True),
        sa.Column("area", sa.String(128), sa.ForeignKey("areas.code", ondelete="CASCADE"), nullable=True),
        sa.Column("is_workday", sa.Boolean, nullable=False),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("day", "area", name="uq_production_calendar_day_area"),
    )
    op.bulk_insert(cal, [{"day": d, "area": None, "is_workday": False, "note": n} for d, n in HOLIDAYS if d.weekday() < 5])


def downgrade() -> None:
    op.drop_table("production_calendar")
    op.drop_table("order_date_changes")
    for c in ("ready_at", "promised_ready", "priority", "amount_rub", "customer"):
        op.drop_column("production_orders", c)
