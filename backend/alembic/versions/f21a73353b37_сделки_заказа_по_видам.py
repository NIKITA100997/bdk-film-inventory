"""сделки заказа клиента по видам продукции (20.10)

Revision ID: f21a73353b37
Revises: d4f6a8c0e2b3
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f21a73353b37"
down_revision: Union[str, Sequence[str], None] = "d4f6a8c0e2b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "customer_order_deals",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("customer_orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("deal_id", sa.Integer(), nullable=False),
        sa.Column("direction", sa.String(16), nullable=True),
        sa.Column("title", sa.String(255), nullable=True),
        sa.Column("stage_sent", sa.String(16), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_customer_order_deals_order_id", "customer_order_deals", ["order_id"])
    op.create_index("ix_customer_order_deals_deal_id", "customer_order_deals", ["deal_id"], unique=True)
    # уже привязанные: вид — общий у всех строк заказа (направление позиции или её типа), иначе на весь заказ
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, bitrix_deal_id, bitrix_stage_sent FROM customer_orders WHERE bitrix_deal_id IS NOT NULL")).fetchall()
    for oid, did, sent in rows:
        dirs = {
            d for (d,) in conn.execute(sa.text(
                "SELECT COALESCE(i.direction, t.direction) FROM customer_order_lines l JOIN items i ON i.id = l.item_id "
                "LEFT JOIN item_types t ON t.id = i.type_id WHERE l.order_id = :o"), {"o": oid})
        }
        direction = next(iter(dirs)) if len(dirs) == 1 else None
        conn.execute(sa.text("INSERT INTO customer_order_deals (order_id, deal_id, direction, stage_sent) VALUES (:o, :d, :dir, :s)"),
                     {"o": oid, "d": did, "dir": direction, "s": sent})


def downgrade() -> None:
    op.drop_index("ix_customer_order_deals_deal_id", table_name="customer_order_deals")
    op.drop_index("ix_customer_order_deals_order_id", table_name="customer_order_deals")
    op.drop_table("customer_order_deals")
