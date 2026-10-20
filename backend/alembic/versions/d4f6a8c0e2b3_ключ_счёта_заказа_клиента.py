"""ключ счёта заказа клиента: один счёт — один заказ (20.10)

Revision ID: d4f6a8c0e2b3
Revises: c2e4a6b8d0f1
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4f6a8c0e2b3"
down_revision: Union[str, Sequence[str], None] = "c2e4a6b8d0f1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.services.invoice_1c import invoice_key

    op.add_column("customer_orders", sa.Column("invoice_key", sa.String(64), nullable=True))
    conn = op.get_bind()
    for oid, no in conn.execute(sa.text("SELECT id, invoice_no FROM customer_orders")).fetchall():
        conn.execute(sa.text("UPDATE customer_orders SET invoice_key = :k WHERE id = :i"), {"k": invoice_key(no) or f"#{oid}", "i": oid})
    op.create_index("ix_customer_orders_invoice_key", "customer_orders", ["invoice_key"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_customer_orders_invoice_key", table_name="customer_orders")
    op.drop_column("customer_orders", "invoice_key")
