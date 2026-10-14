"""сделка Битрикс24 у заказа клиента (14.10)

Revision ID: b8d0f2a4c6e7
Revises: a7c9e1f3b5d6
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b8d0f2a4c6e7"
down_revision: Union[str, Sequence[str], None] = "a7c9e1f3b5d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("customer_orders", sa.Column("bitrix_deal_id", sa.Integer, nullable=True, index=True))
    # стадия заказа, по которой сделка уже передвинута, — чтобы не дёргать Битрикс зря
    op.add_column("customer_orders", sa.Column("bitrix_stage_sent", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("customer_orders", "bitrix_stage_sent")
    op.drop_column("customer_orders", "bitrix_deal_id")
