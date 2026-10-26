"""исполнение в строке заказа (26.10)

Свойство типа — «конструкция» (задаёт позицию: маршрут, состав) или
«исполнение» (цвет кромки, тип стекла, цвет молдинга, уплотнитель): не
плодит позиции, хранится в строке заказа и уходит указанием мастеру на
своей операции.

Revision ID: c4afcdd1fae0
Revises: 36720820eac1
Create Date: 2026-10-26 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

revision = "c4afcdd1fae0"
down_revision = "36720820eac1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("item_properties", sa.Column("role", sa.String(16), nullable=False, server_default="construction"))
    op.add_column("item_properties", sa.Column("operation", sa.String(255), nullable=True))
    op.add_column("customer_order_lines", sa.Column("options", sa.JSON(), nullable=True))
    op.add_column("production_order_lines", sa.Column("options", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("production_order_lines", "options")
    op.drop_column("customer_order_lines", "options")
    op.drop_column("item_properties", "operation")
    op.drop_column("item_properties", "role")
